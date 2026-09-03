// Tab Audio Recorder - Background Service Worker
// 複数タブ同時録音対応 / IndexedDB永続化 / クラッシュ復旧

const recordings = new Map(); // tabId -> { audioChunks, animationInterval, currentFrame, startTime, trimSilence }
const TOTAL_FRAMES = 12;
const DB_NAME = 'tab-audio-recorder-db';
const DB_VERSION = 1;
const ALARM_NAME = 'keepalive';

// ========== IndexedDB ==========

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'tabId' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const store = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
        store.createIndex('tabId', 'tabId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDeleteByIndex(storeName, indexName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const idx = tx.objectStore(storeName).index(indexName);
    const req = idx.openCursor(IDBKeyRange.only(value));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAllByIndex(storeName, indexName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const idx = tx.objectStore(storeName).index(indexName);
    const req = idx.getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ========== アイコンアニメーション ==========

function startAnimation(tabId) {
  const rec = recordings.get(tabId);
  if (!rec) return;
  rec.currentFrame = 0;
  rec.animationInterval = setInterval(() => {
    const frame = rec.currentFrame % TOTAL_FRAMES;
    chrome.action.setIcon({
      path: {
        16: `icons/frame_${frame}/icon16.png`,
        48: `icons/frame_${frame}/icon48.png`,
        128: `icons/frame_${frame}/icon128.png`
      },
      tabId: tabId
    });
    rec.currentFrame++;
  }, 150);
}

function stopAnimation(tabId) {
  const rec = recordings.get(tabId);
  if (rec && rec.animationInterval) {
    clearInterval(rec.animationInterval);
    rec.animationInterval = null;
  }
  chrome.action.setIcon({
    path: {
      16: 'icons/normal/icon16.png',
      48: 'icons/normal/icon48.png',
      128: 'icons/normal/icon128.png'
    },
    tabId: tabId
  });
}

// ========== バッジ更新 ==========

function updateBadges() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.action.setBadgeText({ text: '', tabId: tab.id });
    });
  });
  for (const [tabId] of recordings) {
    chrome.action.setBadgeText({ text: '●', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId });
  }
}

// ========== アラームキープアライブ ==========

async function startKeepAlive() {
  if (recordings.size > 0) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.4 }); // ~24秒ごと
  }
}

async function stopKeepAlive() {
  if (recordings.size === 0) {
    chrome.alarms.clear(ALARM_NAME);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    // 録音が無くなったらアラームを止める
    if (recordings.size === 0) {
      chrome.alarms.clear(ALARM_NAME);
    }
  }
});

// ========== 録音制御 ==========

async function startRecording(tabId, trimSilence, autoSave) {
  if (recordings.has(tabId)) {
    return { error: 'このタブは既に録音中です' };
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    const rec = {
      audioChunks: [],
      animationInterval: null,
      currentFrame: 0,
      startTime: Date.now(),
      trimSilence: !!trimSilence,
      autoSave: !!autoSave
    };
    recordings.set(tabId, rec);

    // IndexedDBに録音メタデータを保存
    await dbPut('recordings', {
      tabId: tabId,
      startTime: rec.startTime,
      trimSilence: rec.trimSilence,
      autoSave: rec.autoSave,
      status: 'recording'
    });

    await setupOffscreen();
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tabId: tabId,
      streamId: streamId
    });

    updateBadges();
    startAnimation(tabId);
    startKeepAlive();

    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

async function stopRecording(tabId) {
  if (!recordings.has(tabId)) {
    return { error: 'このタブは録音されていません' };
  }

  // ステータスを finalizing に更新
  try {
    await dbPut('recordings', {
      tabId,
      startTime: recordings.get(tabId).startTime,
      trimSilence: recordings.get(tabId).trimSilence,
      autoSave: recordings.get(tabId).autoSave,
      status: 'finalizing'
    });
  } catch (e) {
    console.error('Failed to update recording status:', e);
  }

  stopAnimation(tabId);
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: tabId });

  return { ok: true };
}

async function stopAllRecordings() {
  for (const tabId of recordings.keys()) {
    await dbPut('recordings', {
      tabId,
      startTime: recordings.get(tabId).startTime,
      trimSilence: recordings.get(tabId).trimSilence,
      autoSave: recordings.get(tabId).autoSave,
      status: 'finalizing'
    });
    stopAnimation(tabId);
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: tabId });
  }
}

async function setupOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Audio recording'
    });
  }
}

// ========== チャンク保存 (メモリ + IndexedDB) ==========

async function saveAudioChunk(tabId, chunkBase64) {
  const rec = recordings.get(tabId);
  if (!rec) return;

  const binary = atob(chunkBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  rec.audioChunks.push(bytes);

  // IndexedDBにも即座に保存（クラッシュ復旧用）
  try {
    const chunkCount = rec.audioChunks.length;
    await dbPut('chunks', {
      tabId: tabId,
      index: chunkCount - 1,
      data: bytes,
      timestamp: Date.now()
    });
  } catch (e) {
    console.error('Failed to persist chunk to IndexedDB:', e);
  }
}

// ========== 録音完了 → ダウンロード ==========

async function finalizeRecording(tabId) {
  const rec = recordings.get(tabId);
  if (!rec || rec.audioChunks.length === 0) {
    recordings.delete(tabId);
    await cleanupRecordingDB(tabId);
    updateBadges();
    stopKeepAlive();
    return;
  }

  const totalLength = rec.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of rec.audioChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const trimSilence = rec.trimSilence;
  const autoSave = rec.autoSave;
  recordings.delete(tabId);
  await cleanupRecordingDB(tabId);
  updateBadges();
  stopKeepAlive();

  // Base64に変換してOffscreenに送信（無音トリミング・自動保存設定を渡す）
  const base64 = arrayBufferToBase64(merged.buffer);
  chrome.runtime.sendMessage({
    type: 'CREATE_DOWNLOAD',
    tabId: tabId,
    audioBase64: base64,
    trimSilence: trimSilence,
    autoSave: autoSave
  });
}

async function cleanupRecordingDB(tabId) {
  try {
    await dbDelete('recordings', tabId);
    await dbDeleteByIndex('chunks', 'tabId', tabId);
  } catch (e) {
    console.error('Failed to cleanup IndexedDB:', e);
  }
}

// ========== クラッシュ復旧 ==========

async function getRecoverableRecordings() {
  try {
    const all = await dbGetAll('recordings');
    return all.filter(r => r.status === 'recording' || r.status === 'finalizing');
  } catch (e) {
    return [];
  }
}

async function recoverRecording(tabId) {
  try {
    // IndexedDBからチャンクを読み込み
    const chunks = await dbGetAllByIndex('chunks', 'tabId', tabId);
    if (chunks.length === 0) return { error: '復旧データが見つかりません' };

    // インデックス順にソート
    chunks.sort((a, b) => a.index - b.index);

    const totalLength = chunks.reduce((sum, c) => sum + c.data.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c.data, offset);
      offset += c.data.length;
    }

    // メタデータを取得
    const meta = await new Promise(async (resolve) => {
      try {
        const db = await openDB();
        const tx = db.transaction('recordings', 'readonly');
        const req = tx.objectStore('recordings').get(tabId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });

    const trimSilence = meta?.trimSilence ?? false;
    const autoSave = meta?.autoSave ?? false;

    // クリーンアップ
    await cleanupRecordingDB(tabId);

    // ダウンロード
    const base64 = arrayBufferToBase64(merged.buffer);
    chrome.runtime.sendMessage({
      type: 'CREATE_DOWNLOAD',
      tabId: tabId,
      audioBase64: base64,
      trimSilence: trimSilence,
      autoSave: autoSave
    });

    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

// ========== ユーティリティ ==========

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ローカル時刻の YYYYMMDDHHMMSS 形式
function timestampForFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ========== メッセージリスナー ==========

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.tabId, msg.trimSilence, msg.autoSave).then(res => sendResponse(res));
    return true;
  }

  if (msg.type === 'STOP_RECORDING') {
    stopRecording(msg.tabId).then(res => sendResponse(res));
    return true;
  }

  if (msg.type === 'STOP_ALL') {
    stopAllRecordings().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    const rec = recordings.get(msg.tabId);
    sendResponse({ isRecording: !!rec, startTime: rec ? rec.startTime : null });
    return true;
  }

  if (msg.type === 'GET_ALL_RECORDINGS') {
    const list = Array.from(recordings.keys()).map(id => ({ tabId: id }));
    sendResponse({ recordings: list });
    return true;
  }

  if (msg.type === 'AUDIO_CHUNK') {
    saveAudioChunk(msg.tabId, msg.chunk).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'FINALIZE_RECORDING') {
    finalizeRecording(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'DOWNLOAD_READY') {
    const filename = `tab${msg.tabId}_${timestampForFilename()}.webm`;
    chrome.downloads.download({
      url: msg.url,
      filename: filename,
      saveAs: !msg.autoSave // 自動保存ONならダイアログを出さず即保存
    }, () => {
      chrome.runtime.sendMessage({ type: 'CLEANUP_URL', urlId: msg.urlId });
    });
    sendResponse({ ok: true });
    return true;
  }

  // 復旧関連
  if (msg.type === 'GET_RECOVERABLE') {
    getRecoverableRecordings().then(recordings => {
      sendResponse({ recordings });
    });
    return true;
  }

  if (msg.type === 'RECOVER_RECORDING') {
    recoverRecording(msg.tabId).then(res => sendResponse(res));
    return true;
  }
});
