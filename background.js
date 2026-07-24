// Tab Audio Recorder - Background Service Worker

let audioChunks = [];
let recordingTabId = null;
let animationInterval = null;
let currentFrame = 0;
let isRecording = false;
const TOTAL_FRAMES = 12;

// --- アイコンアニメーション ---
function startAnimation(tabId) {
  stopAnimation();
  currentFrame = 0;
  
  animationInterval = setInterval(() => {
    const frame = currentFrame % TOTAL_FRAMES;
    chrome.action.setIcon({
      path: {
        16: `icons/frame_${frame}/icon16.png`,
        48: `icons/frame_${frame}/icon48.png`,
        128: `icons/frame_${frame}/icon128.png`
      },
      tabId: tabId
    });
    currentFrame++;
  }, 150);
}

function stopAnimation() {
  if (animationInterval) {
    clearInterval(animationInterval);
    animationInterval = null;
  }
  chrome.action.setIcon({
    path: {
      16: 'icons/normal/icon16.png',
      48: 'icons/normal/icon48.png',
      128: 'icons/normal/icon128.png'
    }
  });
}

// --- 録音制御 ---
async function startRecording(tabId) {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    isRecording = true;
    recordingTabId = tabId;

    await setupOffscreen();
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      streamId: streamId
    });

    chrome.action.setBadgeText({ text: '●', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#e74c3c', tabId });
    startAnimation(tabId);

    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

async function stopRecording() {
  isRecording = false;
  recordingTabId = null;
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  chrome.action.setBadgeText({ text: '' });
  stopAnimation();
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

// 音声チャンクを保存
function saveAudioChunk(chunkBase64) {
  const binary = atob(chunkBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  audioChunks.push(bytes);
}

// 録音完了 → OffscreenでBlob作成 → ダウンロード
async function finalizeRecording() {
  if (audioChunks.length === 0) return;

  // 全チャンクを結合
  const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  audioChunks = [];

  // Base64に変換してOffscreenに送信（Blob作成はOffscreenで行う）
  const base64 = arrayBufferToBase64(merged.buffer);
  chrome.runtime.sendMessage({
    type: 'CREATE_DOWNLOAD',
    audioBase64: base64
  });
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
    stopRecording().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    sendResponse({ isRecording: isRecording });
    return true;
  }

  if (msg.type === 'AUDIO_CHUNK') {
    saveAudioChunk(msg.chunk);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'FINALIZE_RECORDING') {
    finalizeRecording().then(() => sendResponse({ ok: true }));
    return true;
  }

  // OffscreenからダウンロードURLを受信
  if (msg.type === 'DOWNLOAD_READY') {
    const now = new Date();
    const filename = `recording_${now.toISOString().slice(0,10)}_${now.toTimeString().slice(0,8).replace(/:/g,'')}.webm`;
    chrome.downloads.download({
      url: msg.url,
      filename: filename,
      saveAs: true
    }, () => {
      // URLをクリーンアップするためにOffscreenに通知
      chrome.runtime.sendMessage({ type: 'CLEANUP_URL', urlId: msg.urlId });
    });
    sendResponse({ ok: true });
    return true;
  }
});
