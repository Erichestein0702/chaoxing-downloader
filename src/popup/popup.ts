import { PPTResource } from '../types';

let detectedPPTs: PPTResource[] = [];

document.addEventListener('DOMContentLoaded', () => {
  const scanBtn = document.getElementById('scan-btn');
  const downloadAllBtn = document.getElementById('download-all-btn');
  const pptList = document.getElementById('ppt-list');
  const pptCount = document.getElementById('ppt-count');
  const pageStatus = document.getElementById('page-status');

  checkCurrentPage();

  scanBtn?.addEventListener('click', handleScan);
  downloadAllBtn?.addEventListener('click', handleBatchDownload);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PPT_LIST_RESULT') {
      updatePPTList(message.ppts);
    }
    
    if (message.type === 'DOWNLOAD_PROGRESS') {
      updateProgress(message.progress, message.status);
    }

    if (message.type === 'SHOW_NOTIFICATION') {
      showNotification(message.message, message.type);
    }
  });
});

async function checkCurrentPage() {
  const pageStatus = document.getElementById('page-status') as HTMLElement;
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.url) {
      pageStatus.textContent = '❌ 无法访问';
      return;
    }

    const isChaoxing = tab.url.includes('chaoxing.com');
    
    if (isChaoxing) {
      pageStatus.textContent = '✅ 学习通页面';
      pageStatus.style.color = '#28a745';
    } else {
      pageStatus.textContent = '❌ 非学习通页面';
      pageStatus.style.color = '#dc3545';
    }
  } catch (error) {
    pageStatus.textContent = '⚠️ 检测失败';
    pageStatus.style.color = '#ffc107';
  }
}

async function handleScan() {
  const scanBtn = document.getElementById('scan-btn') as HTMLButtonElement;
  
  scanBtn.textContent = '⏳ 扫描中...';
  scanBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) throw new Error('无法获取当前标签页');

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'GET_PPT_LIST'
    });

    if (response?.ppts) {
      updatePPTList(response.ppts);
      showNotification(`扫描完成！发现 ${response.ppts.length} 个PPT`, 'success');
    } else {
      showNotification('未发现PPT资源', 'info');
    }
  } catch (error) {
    console.error('扫描错误:', error);
    showNotification('扫描失败：请确保在学习通页面操作', 'error');
  } finally {
    scanBtn.textContent = '🔎 扫描当前页面';
    scanBtn.disabled = false;
  }
}

function updatePPTList(ppts: PPTResource[]) {
  detectedPPTs = ppts;
  const pptListEl = document.getElementById('ppt-list');
  const pptCountEl = document.getElementById('ppt-count');
  const downloadAllBtn = document.getElementById('download-all-btn') as HTMLButtonElement;

  if (!pptListEl || !pptCountEl) return;

  pptCountEl.textContent = `${ppts.length} 个`;

  if (ppts.length > 0) {
    downloadAllBtn.disabled = false;
    
    pptListEl.innerHTML = ppts.map((ppt, index) => `
      <div class="ppt-item" data-index="${index}">
        <div class="ppt-info">
          <div class="ppt-title">${escapeHtml(ppt.title)}</div>
          <div class="ppt-meta">${ppt.type.toUpperCase()} ${ppt.downloaded ? '✓ 已下载' : ''}</div>
        </div>
        <span class="ppt-type-badge">${ppt.type.toUpperCase()}</span>
        <button class="download-single-btn" data-index="${index}">
          下载
        </button>
      </div>
    `).join('');

    pptListEl.querySelectorAll('.download-single-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const index = parseInt((e.target as HTMLElement).dataset.index || '0');
        handleSingleDownload(ppts[index]);
      });
    });
  } else {
    downloadAllBtn.disabled = true;
    pptListEl.innerHTML = `
      <div class="empty-state">
        <p>😅 当前页面未检测到PPT资源</p>
        <p style="font-size: 12px; margin-top: 5px;">请进入课程章节页面后重试</p>
      </div>
    `;
  }
}

function handleSingleDownload(ppt: PPTResource) {
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_PPT',
    ppt
  });

  addLogEntry(`开始下载: ${ppt.title}`, 'info');
}

function handleBatchDownload() {
  if (detectedPPTs.length === 0) {
    showNotification('没有可下载的PPT', 'error');
    return;
  }

  const undownloaded = detectedPPTs.filter(ppt => !ppt.downloaded);

  if (undownloaded.length === 0) {
    showNotification('所有PPT已下载完毕！', 'success');
    return;
  }

  chrome.runtime.sendMessage({
    type: 'BATCH_DOWNLOAD',
    ppts: undownloaded
  });

  document.getElementById('progress-section')!.style.display = 'block';
  addLogEntry(`开始批量下载，共 ${undownloaded.length} 个文件`, 'info');
}

function updateProgress(progress: number, status: string) {
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const progressSection = document.getElementById('progress-section');

  if (progressSection) progressSection.style.display = 'block';
  if (progressFill) progressFill.style.width = `${progress}%`;
  if (progressText) progressText.textContent = `${Math.round(progress)}%`;
}

function addLogEntry(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const taskLog = document.getElementById('task-log');
  if (!taskLog) return;

  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  taskLog.insertBefore(entry, taskLog.firstChild);

  if (taskLog.children.length > 50) {
    taskLog.removeChild(taskLog.lastChild!);
  }
}

function showNotification(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    border-radius: 8px;
    color: white;
    font-weight: 600;
    z-index: 10000;
    animation: slideDown 0.3s ease;
    ${
      type === 'success' ? 'background: #28a745;' :
      type === 'error' ? 'background: #dc3545;' :
      'background: #17a2b8;'
    }
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideUp 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const style = document.createElement('style');
style.textContent = `
  @keyframes slideDown {
    from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
  @keyframes slideUp {
    from { opacity: 1; transform: translateX(-50%) translateY(0); }
    to { opacity: 0; transform: translateX(-50%) translateY(-20px); }
  }
`;
document.head.appendChild(style);
