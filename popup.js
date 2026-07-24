let recording = false;
const recordBtn = document.getElementById('recordBtn');
const statusEl = document.getElementById('status');

// 状態を取得してUI更新
function loadStatus() {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (res) => {
    if (res) {
      recording = res.isRecording;
      updateUI();
    }
  });
}

function updateUI() {
  if (recording) {
    recordBtn.textContent = '録音停止';
    recordBtn.classList.add('active');
    statusEl.textContent = '🔴 録音中';
    statusEl.classList.add('active');
  } else {
    recordBtn.textContent = '録音開始';
    recordBtn.classList.remove('active');
    statusEl.textContent = '準備完了';
    statusEl.classList.remove('active');
  }
}

recordBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (!recording) {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id }, (res) => {
      if (res?.error) {
        statusEl.textContent = 'エラー: ' + res.error;
      } else {
        recording = true;
        updateUI();
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, () => {
      recording = false;
      updateUI();
    });
  }
});

// 初期化
loadStatus();
