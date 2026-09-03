// Offscreen Document - Audio Recording
// 複数タブ同時録音対応 / 無音トリミング対応

const recorders = new Map(); // tabId -> { mediaRecorder, stream }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.tabId, msg.streamId).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'STOP_RECORDING') {
    stopRecording(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  } else if (msg.type === 'CREATE_DOWNLOAD') {
    createDownloadUrl(msg.tabId, msg.audioBase64, msg.trimSilence, msg.autoSave);
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

// ========== 無音トリミング ==========

function findFirstNonSilentSample(channelData, threshold) {
  for (let i = 0; i < channelData.length; i++) {
    if (Math.abs(channelData[i]) > threshold) {
      return i;
    }
  }
  return -1; // 全て無音
}

async function trimLeadingSilence(blob, threshold = 0.01) {
  const audioCtx = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const channelData = audioBuffer.getChannelData(0);
    const firstSample = findFirstNonSilentSample(channelData, threshold);

    if (firstSample <= 0) {
      await audioCtx.close();
      return blob; // トリミング不要
    }

    // 0.1秒分のバッファを先頭に追加（トリミング位置の余裕）
    const sampleRate = audioBuffer.sampleRate;
    const paddingSamples = Math.floor(sampleRate * 0.1);
    const startSample = Math.max(0, firstSample - paddingSamples);

    // 新しいバッファを作成
    const trimmedLength = audioBuffer.length - startSample;
    const trimmedBuffer = audioCtx.createBuffer(
      audioBuffer.numberOfChannels,
      trimmedLength,
      sampleRate
    );

    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const src = audioBuffer.getChannelData(ch);
      const dst = trimmedBuffer.getChannelData(ch);
      for (let i = 0; i < trimmedLength; i++) {
        dst[i] = src[startSample + i];
      }
    }

    // AudioBuffer → Blob (WebM) に変換
    const result = await audioBufferToBlob(trimmedBuffer);
    await audioCtx.close();
    return result;
  } catch (e) {
    console.error('Silence trimming failed, returning original:', e);
    await audioCtx.close().catch(() => {});
    return blob;
  }
}

function audioBufferToBlob(audioBuffer) {
  return new Promise((resolve, reject) => {
    const ctx = new OfflineAudioContext(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate
    );

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);

    const recorder = new MediaRecorder(dest.stream, {
      mimeType: 'audio/webm;codecs=opus'
    });
    const chunks = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: 'audio/webm' }));
    };

    recorder.onerror = (e) => reject(e);

    recorder.start();
    source.start(0);
    source.onended = () => {
      recorder.stop();
    };
  });
}

// ========== ダウンロードURL作成 ==========

async function createDownloadUrl(tabId, base64, trimSilence, autoSave) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  let blob = new Blob([bytes], { type: 'audio/webm' });

  // 無音トリミングが有効な場合
  if (trimSilence) {
    blob = await trimLeadingSilence(blob);
  }

  const url = URL.createObjectURL(blob);
  const urlId = `${tabId}_${Date.now()}`;
  blobUrls.push({ id: urlId, url });

  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_READY',
    tabId: tabId,
    url: url,
    urlId: urlId,
    autoSave: !!autoSave
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
