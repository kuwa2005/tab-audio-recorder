// Offscreen Document - Audio Recording

let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let blobUrls = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.streamId).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'STOP_RECORDING') {
    stopRecording().then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'CREATE_DOWNLOAD') {
    // Base64 → Blob → URL作成 → Backgroundに送信
    createDownloadUrl(msg.audioBase64);
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === 'CLEANUP_URL') {
    // 使用済みURLを解放
    const idx = blobUrls.findIndex(u => u.id === msg.urlId);
    if (idx !== -1) {
      URL.revokeObjectURL(blobUrls[idx].url);
      blobUrls.splice(idx, 1);
    }
    sendResponse({ ok: true });
    return true;
  }
  return true;
});

function createDownloadUrl(base64) {
  // Base64 → Uint8Array
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  // Blob作成 → URL作成
  const blob = new Blob([bytes], { type: 'audio/webm' });
  const url = URL.createObjectURL(blob);
  const urlId = Date.now().toString();
  blobUrls.push({ id: urlId, url });

  // BackgroundにURLを送信
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_READY',
    url: url,
    urlId: urlId
  });
}

async function startRecording(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    }
  });

  audioChunks = [];
  isRecording = true;

  // 音声をスピーカーに返す（消音防止）
  try {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);
  } catch (e) {
    console.log('Audio redirect failed:', e);
  }

  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

  mediaRecorder.ondataavailable = async (e) => {
    if (e.data.size > 0 && isRecording) {
      const buffer = await e.data.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      chrome.runtime.sendMessage({ type: 'AUDIO_CHUNK', chunk: base64 });
    }
  };

  mediaRecorder.onstop = async () => {
    isRecording = false;
    chrome.runtime.sendMessage({ type: 'FINALIZE_RECORDING' });
    stream.getTracks().forEach(t => t.stop());
  };

  mediaRecorder.start(5000);
}

async function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
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
