import { PPTResource } from '../types';

interface AppSettings {
  autoScan: string;
  downloadMode: string;
  fileTypes: string[];
}

const DEFAULT_SETTINGS: AppSettings = {
  autoScan: 'off',
  downloadMode: 'dialog',
  fileTypes: ['ppt', 'pdf', 'mp4', 'doc', 'xls', 'zip']
};

let detectedPPTs: PPTResource[] = [];

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  loadSettings();
  initMainPage();
});

// ===== 标签页切换 =====

function initTabs(): void {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tabId = (btn as HTMLElement).dataset.tab;
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
      const target = document.getElementById('tab-' + tabId);
      if (target) target.classList.add('active');
    });
  });
}

// ===== 设置面板 =====

async function loadSettings(): Promise<void> {
  try {
    const result = await chrome.storage.local.get('settings');
    const settings: AppSettings = result.settings || DEFAULT_SETTINGS;

    const autoScan = document.getElementById('setting-auto-scan') as HTMLSelectElement;
    const dlMode = document.getElementById('setting-download-mode') as HTMLSelectElement;
    if (autoScan) autoScan.value = settings.autoScan;
    if (dlMode) dlMode.value = settings.downloadMode;

    const checkboxes = document.querySelectorAll('#type-filters input[type="checkbox"]');
    checkboxes.forEach(cb => {
      (cb as HTMLInputElement).checked = settings.fileTypes.indexOf((cb as HTMLInputElement).value) !== -1;
    });
  } catch (e) {
    console.error('加载设置失败:', e);
  }

  const saveBtn = document.getElementById('save-settings-btn');
  saveBtn?.addEventListener('click', saveSettings);
}

async function saveSettings(): Promise<void> {
  const autoScan = (document.getElementById('setting-auto-scan') as HTMLSelectElement).value;
  const dlMode = (document.getElementById('setting-download-mode') as HTMLSelectElement).value;

  const fileTypes: string[] = [];
  document.querySelectorAll('#type-filters input[type="checkbox"]:checked').forEach(cb => {
    fileTypes.push((cb as HTMLInputElement).value);
  });

  const settings: AppSettings = { autoScan, downloadMode: dlMode, fileTypes };

  await chrome.storage.local.set({ settings });
  showNotification('✅ 设置已保存', 'success');

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'SETTINGS_UPDATED', settings });
    }
  });
}

// ===== 主页功能 =====

function initMainPage(): void {
  const scanBtn = document.getElementById('scan-btn');
  const downloadAllBtn = document.getElementById('download-all-btn');

  checkCurrentPage();
  scanBtn?.addEventListener('click', handleScan);
  downloadAllBtn?.addEventListener('click', handleBatchDownload);

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'PPT_LIST_RESULT') updatePPTList(message.ppts);
    if (message.type === 'DOWNLOAD_PROGRESS') updateProgress(message.progress, message.status);
    if (message.type === 'SHOW_NOTIFICATION') showNotification(message.message, message.notificationType);
  });
}

async function checkCurrentPage(): Promise<void> {
  const pageStatus = document.getElementById('page-status') as HTMLElement;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) { pageStatus.textContent = '❌ 无法访问'; return; }

    if (tab.url.includes('chaoxing.com')) {
      pageStatus.textContent = '✅ 学习通页面';
      pageStatus.style.color = '#28a745';
    } else {
      pageStatus.textContent = '❌ 非学习通页面';
      pageStatus.style.color = '#dc3545';
    }
  } catch (_e) {
    pageStatus.textContent = '⚠️ 检测失败';
    pageStatus.style.color = '#ffc107';
  }
}

async function handleScan(): Promise<void> {
  const scanBtn = document.getElementById('scan-btn') as HTMLButtonElement;
  scanBtn.textContent = '⏳ 扫描中...';
  scanBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('无法获取当前标签页');

    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PPT_LIST' });

    if (response?.ppts) {
      updatePPTList(response.ppts);
      showNotification('扫描完成！发现 ' + response.ppts.length + ' 个资源', 'success');
    } else {
      showNotification('未发现资源', 'info');
    }
  } catch (e) {
    console.error('扫描错误:', e);
    showNotification('扫描失败：请确保在学习通页面操作', 'error');
  } finally {
    scanBtn.textContent = '🔎 扫描当前页面';
    scanBtn.disabled = false;
  }
}

function updatePPTList(ppts: PPTResource[]): void {
  detectedPPTs = ppts;
  const pptListEl = document.getElementById('ppt-list');
  const pptCountEl = document.getElementById('ppt-count');
  const downloadAllBtn = document.getElementById('download-all-btn') as HTMLButtonElement;
  if (!pptListEl || !pptCountEl) return;

  pptCountEl.textContent = ppts.length + ' 个';
  pptListEl.innerHTML = '';

  if (ppts.length > 0) {
    downloadAllBtn.disabled = false;

    ppts.forEach((ppt, i) => {
      const item = document.createElement('div');
      item.className = 'ppt-item';
      item.dataset.index = String(i);

      item.innerHTML =
        '<div class="ppt-info">' +
          '<div class="ppt-title">' + escapeHtml(ppt.title) + '</div>' +
          '<div class="ppt-meta">' + ppt.type.toUpperCase() + (ppt.downloaded ? ' ✓ 已下载' : '') + '</div>' +
        '</div>' +
        '<span class="ppt-type-badge">' + ppt.type.toUpperCase() + '</span>' +
        '<button class="download-single-btn" data-index="' + i + '">下载</button>';

      pptListEl.appendChild(item);

      item.querySelector('.download-single-btn')?.addEventListener('click', () => handleSingleDownload(ppt));
    });
  } else {
    downloadAllBtn.disabled = true;
    pptListEl.innerHTML = '<div class="empty-state"><p>😅 当前页面未检测到资源</p></div>';
  }
}

function handleSingleDownload(ppt: PPTResource): void {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id;
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_DOWNLOAD', ppt });
  });
  addLogEntry('开始下载: ' + ppt.title, 'info');
}

function handleBatchDownload(): void {
  if (detectedPPTs.length === 0) { showNotification('没有可下载的资源', 'error'); return; }

  const pending = detectedPPTs.filter(p => !p.downloaded);
  if (pending.length === 0) { showNotification('所有资源已下载完毕！', 'success'); return; }

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id;
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_BATCH_DOWNLOAD', ppts: pending });
  });
  document.getElementById('progress-section')!.style.display = 'block';
  addLogEntry('开始批量下载，共 ' + pending.length + ' 个文件', 'info');
}

function updateProgress(progress: number, status: string): void {
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const progressSection = document.getElementById('progress-section');
  if (progressSection) progressSection.style.display = 'block';
  if (progressFill) progressFill.style.width = Math.round(progress) + '%';
  if (progressText) progressText.textContent = Math.round(progress) + '%';
}

function addLogEntry(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const taskLog = document.getElementById('task-log');
  if (!taskLog) return;

  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
  taskLog.insertBefore(entry, taskLog.firstChild);

  while (taskLog.children.length > 50) {
    taskLog.removeChild(taskLog.lastChild!);
  }
}

function showNotification(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const el = document.createElement('div');
  el.className = 'notification ' + type;
  el.textContent = message;
  el.style.cssText =
    'position:fixed;top:10px;left:50%;transform:translateX(-50%);' +
    'padding:12px 24px;border-radius:8px;color:white;font-weight:600;z-index:10000;' +
    'animation:slideDown 0.3s ease;' +
    (type === 'success' ? 'background:#28a745;' : type === 'error' ? 'background:#dc3545;' : 'background:#17a2b8;');

  document.body.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideUp 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function escapeHtml(text: string): string {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

const style = document.createElement('style');
style.textContent = `
  .tab-nav { display:flex;gap:8px;margin:12px 0;border-bottom:1px solid #eee;padding-bottom:8px; }
  .tab-btn { flex:1;padding:8px;border:none;background:#f0f0f0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;transition:all 0.2s; }
  .tab-btn.active { background:#667eea;color:white; }
  .tab-content { display:none; }
  .tab-content.active { display:block; }
  .setting-item { margin:16px 0; }
  .setting-item label { display:block;font-weight:600;margin-bottom:6px;font-size:13px; }
  .setting-item select { width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px; }
  .type-filters { display:flex;flex-wrap:wrap;gap:8px; }
  .type-filters label { display:flex;align-items:center;gap:4px;font-size:12px;font-weight:normal;cursor:pointer; }
  @keyframes slideDown { from{opacity:0;transform:translateX(-50%)translateY(-20px)} to{opacity:1;transform:translateX(-50%)translateY(0)} }
  @keyframes slideUp { from{opacity:1;transform:translateX(-50%)translateY(0)} to{opacity:0;transform:translateX(-50%)translateY(-20px)} }
`;
document.head.appendChild(style);
