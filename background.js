// Tab Audio Recorder - Background Service Worker
// 複数タブ同時録音対応

const recordings = new Map(); // tabId -> { audioChunks: [], animationInterval, currentFrame }
const TOTAL_FRAMES = 12;

// --- アイコンアニメーション ---
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

// --- バッジ更新 ---
function updateBadges() {
  // 全タブのバッジをクリア
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      chrome.action.setBadgeText({ text: '', tabId: tab.id });
    });
  });

  // 録音中のタブにバッジを設定
  for (const [tabId, rec] of recordings) {
    chrome.action.setBadgeText({ text: '●', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId });
  }
}

// --- 録音制御 ---
async function startRecording(tabId) {
  // 既に録音中の場合はエラー
  if (recordings.has(tabId)) {
    return { error: 'このタブは既に録音中です' };
  }

  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    // タブごとの録音状態を初期化
    recordings.set(tabId, {
      audioChunks: [],
      animationInterval: null,
      currentFrame: 0
    });

    await setupOffscreen();
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tabId: tabId,
      streamId: streamId
    });

    updateBadges();
    startAnimation(tabId);

    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

async function stopRecording(tabId) {
  if (!recordings.has(tabId)) {
    return { error: 'このタブは録音されていません' };
  }

  stopAnimation(tabId);
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: tabId });

  return { ok: true };
}

async function stopAllRecordings() {
  for (const tabId of recordings.keys()) {
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

// タブごとの音声チャンクを保存
function saveAudioChunk(tabId, chunkBase64) {
  const rec = recordings.get(tabId);
  if (!rec) return;

  const binary = atob(chunkBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  rec.audioChunks.push(bytes);
}

// タブごとの録音完了 → ダウンロード
async function finalizeRecording(tabId) {
  const rec = recordings.get(tabId);
  if (!rec || rec.audioChunks.length === 0) {
    recordings.delete(tabId);
    updateBadges();
    return;
  }

  // 全チャンクを結合
  const totalLength = rec.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of rec.audioChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  rec.audioChunks = [];

  // Base64に変換してOffscreenに送信
  const base64 = arrayBufferToBase64(merged.buffer);
  chrome.runtime.sendMessage({
    type: 'CREATE_DOWNLOAD',
    tabId: tabId,
    audioBase64: base64
  });

  // 録音状態を削除
  recordings.delete(tabId);
  updateBadges();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.tabId).then(res => sendResponse(res));
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
    // 現在のタブが録音中かを返す
    const tabId = msg.tabId;
    sendResponse({ isRecording: recordings.has(tabId) });
    return true;
  }

  if (msg.type === 'GET_ALL_RECORDINGS') {
    // 全録音中タブのリストを返す
    const list = Array.from(recordings.keys()).map(id => ({ tabId: id }));
    sendResponse({ recordings: list });
    return true;
  }

  if (msg.type === 'AUDIO_CHUNK') {
    saveAudioChunk(msg.tabId, msg.chunk);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'FINALIZE_RECORDING') {
    finalizeRecording(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  // OffscreenからダウンロードURLを受信
  if (msg.type === 'DOWNLOAD_READY') {
    const now = new Date();
    const filename = `recording_tab${msg.tabId}_${now.toISOString().slice(0,10)}_${now.toTimeString().slice(0,8).replace(/:/g,'')}.webm`;
    chrome.downloads.download({
      url: msg.url,
      filename: filename,
      saveAs: true
    }, () => {
      chrome.runtime.sendMessage({ type: 'CLEANUP_URL', urlId: msg.urlId });
    });
    sendResponse({ ok: true });
    return true;
  }
});
