let recording = false;
const recordBtn = document.getElementById('recordBtn');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const trimSilenceCb = document.getElementById('trimSilence');
const autoSaveCb = document.getElementById('autoSave');
let currentTabId = null;
let recordingStartTime = null;
let elapsedInterval = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    loadStatus();
  }

  // チェックボックス状態を復元
  const { trimSilence, autoSave } = await chrome.storage.local.get(['trimSilence', 'autoSave']);
  trimSilenceCb.checked = !!trimSilence;
  autoSaveCb.checked = !!autoSave;

  // チェックボックス変更時に保存
  trimSilenceCb.addEventListener('change', () => {
    chrome.storage.local.set({ trimSilence: trimSilenceCb.checked });
  });
  autoSaveCb.addEventListener('change', () => {
    chrome.storage.local.set({ autoSave: autoSaveCb.checked });
  });
}

function loadStatus() {
  if (!currentTabId) return;

  chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: currentTabId }, (res) => {
    if (res) {
      recording = res.isRecording;
      recordingStartTime = res.startTime || null;
      updateUI();
    }
  });

  chrome.runtime.sendMessage({ type: 'GET_ALL_RECORDINGS' }, (res) => {
    if (res && res.recordings.length > 0) {
      const count = res.recordings.length;
      statusEl.textContent = `🔴 ${count}タブ録音中`;
    }
  });
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}

function startElapsedTimer() {
  stopElapsedTimer();
  function tick() {
    if (recording && recordingStartTime) {
      timerEl.textContent = formatElapsed(Date.now() - recordingStartTime);
    }
  }
  tick();
  elapsedInterval = setInterval(tick, 1000);
}

function stopElapsedTimer() {
  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
}

function updateUI() {
  if (recording) {
    recordBtn.textContent = '録音停止';
    recordBtn.classList.add('active');
    statusEl.textContent = '🔴 録音中';
    statusEl.classList.add('active');
    trimSilenceCb.disabled = true; // 録音中は変更不可
    autoSaveCb.disabled = true;
    if (recordingStartTime) {
      startElapsedTimer();
      timerEl.hidden = false;
    }
  } else {
    recordBtn.textContent = '録音開始';
    recordBtn.classList.remove('active');
    statusEl.textContent = '準備完了';
    statusEl.classList.remove('active');
    trimSilenceCb.disabled = false;
    autoSaveCb.disabled = false;
    stopElapsedTimer();
    timerEl.hidden = true;
  }
}

// --- 復旧UI ---
function showRecoveryUI(recordings) {
  let container = document.querySelector('.container');
  let recoveryDiv = document.getElementById('recovery');
  if (!recoveryDiv) {
    recoveryDiv = document.createElement('div');
    recoveryDiv.id = 'recovery';
    recoveryDiv.className = 'recovery';
    container.insertBefore(recoveryDiv, document.querySelector('.info'));
  }
  recoveryDiv.innerHTML = `<p class="recovery-title">⚠ 未保存の録音が見つかりました</p>`;
  recordings.forEach(rec => {
    const date = new Date(rec.startTime).toLocaleString('ja-JP');
    const btn = document.createElement('button');
    btn.className = 'btn btn-recovery';
    btn.textContent = `復旧する (${date})`;
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'RECOVER_RECORDING', tabId: rec.tabId }, (res) => {
        if (res?.ok) {
          btn.textContent = '✓ 復旧完了';
          btn.disabled = true;
        } else {
          btn.textContent = '✗ 復旧失敗';
        }
      });
    });
    recoveryDiv.appendChild(btn);
  });
  recoveryDiv.style.display = 'block';
}

recordBtn.addEventListener('click', async () => {
  if (!currentTabId) return;

  if (!recording) {
    const { trimSilence, autoSave } = await chrome.storage.local.get(['trimSilence', 'autoSave']);
    chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tabId: currentTabId,
      trimSilence: !!trimSilence,
      autoSave: !!autoSave
    }, (res) => {
      if (res?.error) {
        statusEl.textContent = res.error;
        statusEl.style.color = '#e74c3c';
        setTimeout(() => { statusEl.style.color = ''; }, 2000);
      } else {
        recording = true;
        recordingStartTime = Date.now();
        updateUI();
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: currentTabId }, () => {
      recording = false;
      recordingStartTime = null;
      updateUI();
    });
  }
});

setInterval(loadStatus, 2000);

init();

// 起動時に復旧可能な録音を確認
chrome.runtime.sendMessage({ type: 'GET_RECOVERABLE' }, (res) => {
  if (res?.recordings?.length > 0) {
    showRecoveryUI(res.recordings);
  }
});
