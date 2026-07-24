// Offscreen Document - Audio Recording
// 複数タブ同時録音対応

const recorders = new Map(); // tabId -> { mediaRecorder, stream }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.tabId, msg.streamId).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'STOP_RECORDING') {
    stopRecording(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'CREATE_DOWNLOAD') {
    createDownloadUrl(msg.tabId, msg.audioBase64);
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === 'CLEANUP_URL') {
    cleanupUrl(msg.urlId);
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

const blobUrls = [];

async function startRecording(tabId, streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  // 音声をスピーカーに返す（消音防止）
  try {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);
  } catch (e) {
    console.log('Audio redirect failed:', e);
  }

  const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0 && recorders.has(tabId)) {
      const buffer = await e.data.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      chrome.runtime.sendMessage({
        type: 'AUDIO_CHUNK',
        tabId: tabId,
        chunk: base64
      });
    }
  };

  mediaRecorder.onstop = async () => {
    const rec = recorders.get(tabId);
    if (rec) {
      stream.getTracks().forEach(t => t.stop());
      recorders.delete(tabId);
    }
    chrome.runtime.sendMessage({
      type: 'FINALIZE_RECORDING',
      tabId: tabId
    });
  };

  mediaRecorder.start(5000);

  recorders.set(tabId, { mediaRecorder, stream });
}

async function stopRecording(tabId) {
  const rec = recorders.get(tabId);
  if (rec && rec.mediaRecorder.state !== 'inactive') {
    rec.mediaRecorder.stop();
  }
}

function createDownloadUrl(tabId, base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const urlId = `${tabId}_${Date.now()}`;
  blobUrls.push({ id: urlId, url });

  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_READY',
    tabId: tabId,
    url: url,
    urlId: urlId
  });
}

function cleanupUrl(urlId) {
  const idx = blobUrls.findIndex(u => u.id === urlId);
  if (idx !== -1) {
    URL.revokeObjectURL(blobUrls[idx].url);
    blobUrls.splice(idx, 1);
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
