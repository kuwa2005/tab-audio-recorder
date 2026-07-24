let recording = false;
const recordBtn = document.getElementById('recordBtn');
const statusEl = document.getElementById('status');
let currentTabId = null;

// 現在のタブIDを取得
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    currentTabId = tab.id;
    loadStatus();
  }
}

// 状態を取得してUI更新
function loadStatus() {
  if (!currentTabId) return;

  chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: currentTabId }, (res) => {
    if (res) {
      recording = res.isRecording;
      updateUI();
    }
  });

  // 全録音中タブのリストも取得
  chrome.runtime.sendMessage({ type: 'GET_ALL_RECORDINGS' }, (res) => {
    if (res && res.recordings.length > 0) {
      const count = res.recordings.length;
      statusEl.textContent = `🔴 ${count}タブ録音中`;
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
  if (!currentTabId) return;

  if (!recording) {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: currentTabId }, (res) => {
      if (res?.error) {
        statusEl.textContent = res.error;
        statusEl.style.color = '#e74c3c';
        setTimeout(() => { statusEl.style.color = ''; }, 2000);
      } else {
        recording = true;
        updateUI();
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: currentTabId }, () => {
      recording = false;
      updateUI();
    });
  }
});

// 定期的に状態を更新（他のタブの録音状態を反映）
setInterval(loadStatus, 2000);

init();
