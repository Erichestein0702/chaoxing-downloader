import { PPTResource, inferFileType } from '../types';

// ============================================================
//  常量与类型
// ============================================================

const CHAOXING_DOMAINS = [
  'mooc1.chaoxing.com',
  'mooc1-1.chaoxing.com',
  'mooc1-2.chaoxing.com',
  'mooc2-ans.chaoxing.com'
];

const CONTAINER_ID = 'chaoxing-ppt-downloader-container';

/** toOpen() 解析结果 */
interface ToOpenParams {
  dataName: string;
  dataType: string;
  dataId: string;
  objectId: string;
  classId: string;
  enc: string;
  t: string;
}

/** status API 返回 */
interface StatusApiResponse {
  download?: string;
  filename?: string;
  pdf?: string;
  preview?: string;
  status?: string;
  [key: string]: unknown;
}

/** V10 Background 响应 */
interface V10Response {
  success: boolean;
  error?: string;
  downloadId?: number;
  blobSize?: number;
  httpStatus?: number;
}

/** 批量下载响应 */
interface BatchV10Response {
  success: boolean;
  totalFiles?: number;
  successCount?: number;
  failCount?: number;
  results?: Array<{ filename: string; success: boolean; error?: string }>;
  error?: string;
}

// ============================================================
//  日志系统
// ============================================================

const LOG_PREFIX = '%c[CS]';
const LOG_STYLE = 'color: #667eea; font-weight: bold;';

function log(...args: unknown[]) {
  console.log(LOG_PREFIX, LOG_STYLE, new Date().toLocaleTimeString(), ...args);
}
function warn(...args: unknown[]) {
  console.warn(LOG_PREFIX, LOG_STYLE, '⚠️', ...args);
}
function logErr(...args: unknown[]) {
  console.error(LOG_PREFIX, LOG_STYLE, '❌', ...args);
}

// ============================================================
//  工具函数
// ============================================================

function isChaoxingHostname(): boolean {
  return CHAOXING_DOMAINS.some(d => window.location.hostname.includes(d));
}

/** 清理文件名非法字符 */
function sanitizeFolderName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
    .trim() || 'ChaoXing_Download';
}

/** 显示用户提示（5秒自动消失） */
function showUserMessage(msg: string): void {
  const old = document.getElementById('ppt-dl-toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.id = 'ppt-dl-toast';
  toast.style.cssText = `
    position: fixed; top: 20px; right: 20px; z-index: 999999;
    background: #667eea; color: white; padding: 12px 20px;
    border-radius: 8px; font-size: 14px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    font-family: -apple-system, sans-serif;
  `;
  toast.textContent = `📥 ${msg}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ============================================================
//  参数解析器 — 解析 toOpen() onclick 属性
// ============================================================

function parseToOpenParams(onclickAttr: string): ToOpenParams | null {
  const cleaned = onclickAttr.replace(/\s+/g, ' ').trim();
  const outerMatch = /toOpen\((.+)\)/.exec(cleaned);
  if (!outerMatch) return null;

  const inner = outerMatch[1];
  const params: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'") {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      params.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current.trim());

  if (params.length < 13) return null;

  const p = params.map(s => s.replace(/^'|'$/g, ''));

  return {
    dataName: decodeURIComponent(p[0]),
    dataType: p[1],
    dataId: p[2],
    objectId: p[4],
    classId: p[8],
    enc: p[9],
    t: p[11]
  };
}

// ============================================================
//  API 请求层 — status API 调用 + CDN 直链提取
// ============================================================

/**
 * 构造候选下载 URL 列表（按优先级排序）
 * 注意：所有 status API 统一使用 mooc1.chaoxing.com 避免跨域问题
 */
function buildCandidateUrls(meta: Record<string, string>): Array<{ method: string; url: string }> {
  const urls: Array<{ method: string; url: string }> = [];
  const { objectId, classId, enc, t } = meta;
  if (!objectId) return urls;

  // 1. 主站 status API（同域请求，不受CORS限制）
  let statusUrl = 'https://mooc1.chaoxing.com/ananas/status/' + objectId + '?flag=normal';
  if (classId) statusUrl += '&courseid=' + classId;
  if (enc) statusUrl += '&enc=' + encodeURIComponent(enc);
  if (t) statusUrl += '&t=' + t;
  urls.push({ method: 'status_fetch', url: statusUrl });

  // 2. 预览链接 fallback
  urls.push({
    method: 'open_window',
    url: 'https://mooc1.chaoxing.com/ananas/preview/' + objectId + '?courseid=' + (classId || '')
  });

  // 3. 直接附件下载
  if (enc && t) {
    urls.push({
      method: 'direct_download',
      url: 'https://ans-attachment.chaoxing.com/full/' + objectId + '?courceid=' + (classId || '') + '&enc=' + encodeURIComponent(enc) + '&t=' + t
    });
  }

  return urls;
}

/**
 * 请求 status API 并提取 CDN 直链
 * 优先级: pdf(s3.cldisk.com) > download(d0.cldisk.com) > preview
 */
async function fetchStatusAndGetDownloadUrl(statusUrl: string): Promise<{ url: string; isPdf: boolean } | null> {
  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json, text/plain, */*' }
    });

    if (!response.ok) return null;

    const text = await response.text();
    if (!text || text.length < 5) return null;

    const data = JSON.parse(text) as StatusApiResponse;

    // 优先使用 pdf 字段（最可靠，实测验证）
    if (data.pdf) return { url: data.pdf, isPdf: true };
    if (data.download) return { url: data.download, isPdf: false };
    if (data.preview) return { url: data.preview, isPdf: false };

    return null;
  } catch (e) {
    log(`[statusFetch] 错误: ${(e as Error).message}`);
    return null;
  }
}

// ============================================================
//  下载引擎 — V10 主路径 + Fallback
// ============================================================

/**
 * 发送消息给 Background Service Worker（V10 单文件下载）
 */
function sendToBackgroundV10(cdnUrl: string, filename: string): Promise<V10Response> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'FETCH_AND_DOWNLOAD_V10', url: cdnUrl, filename },
      (response: V10Response) => resolve(response || { success: false, error: '无响应（可能SW超时）' })
    );
    setTimeout(() => resolve({ success: false, error: 'Background响应超时(30s)' }), 30000);
  });
}

/**
 * Fallback: 用隐藏 <a> 标签触发浏览器导航下载
 */
function navigateToDownload(url: string, _filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.cssText = 'position:absolute;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';
  document.body.appendChild(link);

  try {
    link.click();
    setTimeout(() => { if (link.parentNode) link.parentNode.removeChild(link); }, 1000);
  } catch (e) {
    logErr(`[navigateDL] click失败: ${(e as Error).message}`);
    window.open(url, '_blank');
    if (link.parentNode) link.parentNode.removeChild(link);
  }
}

/**
 * 调用页面原生的 toOpen() 函数（最终兜底）
 */
function invokeOriginalToOpen(ppt: PPTResource): void {
  const meta = ppt.meta || {};
  const win = window as unknown as Record<string, unknown>;
  if (typeof win.toOpen === 'function') {
    (win.toOpen as Function)(
      meta.dataName || ppt.title,
      meta.dataType || ppt.type,
      meta.dataId || '',
      '', meta.objectId || '', '', '', meta.classId || '', meta.enc || '', '', meta.t || ''
    );
  } else {
    window.open('about:blank', '_blank');
  }
}

/**
 * V10 单个文件下载主入口
 * 流程: 候选URL → status API → CDN直链 → BG fetch → chrome.downloads → (失败则fallback)
 */
async function downloadPPTFromContent(ppt: PPTResource): Promise<void> {
  log(`[V10] 开始: ${ppt.title}`);
  const meta = ppt.meta || {};
  const candidateUrls = buildCandidateUrls(meta);

  for (let i = 0; i < candidateUrls.length; i++) {
    const { method, url } = candidateUrls[i];
    log(`[V10] 尝试方案${i + 1}: ${method} → ${url.substring(0, 100)}...`);

    try {
      if (method === 'status_fetch') {
        const result = await fetchStatusAndGetDownloadUrl(url);
        if (result) {
          const ext = result.isPdf ? 'pdf' : ppt.type;
          const filename = `${ppt.title}.${ext}`;

          const v10Result = await sendToBackgroundV10(result.url, filename);

          if (v10Result.success) {
            ppt.downloaded = true;
            showUserMessage(`${ppt.title} 已弹出保存对话框！`);
            log(`[V10] ✅✅✅ 成功! id=${v10Result.downloadId}`);
            return;
          }

          log(`[V10] ⚠️ 失败: ${v10Result.error}`);
          showUserMessage(`${ppt.title}: 使用备用方案`);
          navigateToDownload(result.url, filename);
          ppt.downloaded = true;
          return;
        }
      } else if (method === 'open_window') {
        const newWin = window.open(url, '_blank');
        if (newWin) { ppt.downloaded = true; showUserMessage(`${ppt.title} 已在新窗口打开`); return; }
      } else if (method === 'direct_download') {
        navigateToDownload(url, `${ppt.title}.${ppt.type}`);
        ppt.downloaded = true;
        return;
      }
    } catch (e) {
      log(`[V10] 方案${i + 1} 异常: ${(e as Error).message}`);
    }
  }

  log(`[V10] 最终兜底: invokeOriginalToOpen`);
  invokeOriginalToOpen(ppt);
  ppt.downloaded = true;
}

// ============================================================
//  批量下载引擎
// ============================================================

let isDownloading = false;

/** 提取课程名用作子文件夹 */
function extractCourseFolderName(): string {
  const h1 = document.querySelector('h1, h2, h3');
  if (h1?.textContent?.trim()) return h1.textContent.trim();

  const title = document.title.trim()
    .replace(/\s*[-|–—]\s*(超星|学习通|ChaoXing|mooc|在线学习|教学平台).*$/i, '')
    .trim();
  if (title) return title;

  return 'ChaoXing_PPT';
}

/**
 * 带重试的 status API 请求
 * @param url status API 地址
 * @param maxRetries 最大重试次数
 */
async function fetchStatusWithRetry(url: string, maxRetries: number = 2): Promise<{ url: string; isPdf: boolean } | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      log(`[retry] 第${attempt}次重试: ${url.substring(0, 80)}...`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }

    const result = await fetchStatusAndGetDownloadUrl(url);
    if (result) return result;
  }
  return null;
}

/** 更新批量下载进度 UI */
function updateBatchProgress(current: number, total: string, msg: string): void {
  const dlBtn = document.getElementById('download-all-btn');
  if (dlBtn) dlBtn.textContent = '⏳ ' + current + '/' + total + ' ' + msg;
  showUserMessage('📥 (' + current + '/' + total + ') ' + msg);
}

/**
 * V10 批量下载主流程（增强版）
 * - 实时进度显示
 * - 失败自动重试（2次）
 * - 详细错误日志
 */
async function batchDownloadV10(ppts: PPTResource[]): Promise<void> {
  const folderName = extractCourseFolderName();
  const total = String(ppts.length);
  log('[V10-BATCH] 文件夹: ' + folderName);

  updateBatchProgress(0, total, '获取链接中...');
  const files: Array<{ cdnUrl: string; filename: string }> = [];
  const failedNames: string[] = [];

  for (let i = 0; i < ppts.length; i++) {
    const ppt = ppts[i];
    const meta = ppt.meta || {};
    const candidates = buildCandidateUrls(meta);

    updateBatchProgress(i + 1, total, '获取 ' + ppt.title + ' 链接...');

    let gotUrl = false;
    for (const { method, url } of candidates) {
      if (method === 'status_fetch') {
        const result = await fetchStatusWithRetry(url, 2);
        if (result) {
          const ext = result.isPdf ? 'pdf' : ppt.type;
          files.push({ cdnUrl: result.url, filename: ppt.title + '.' + ext });
          gotUrl = true;
          log('[V10-BATCH] ✅ ' + ppt.title + ': 直链就绪');
          break;
        }
      }
    }

    if (!gotUrl) {
      failedNames.push(ppt.title);
      log('[V10-BATCH] ❌ ' + ppt.title + ': 无法获取直链接');
    }

    if (i < ppts.length - 1) await new Promise(r => setTimeout(r, 200));
  }

  if (files.length === 0) {
    showUserMessage('❌ 所有文件都无法获取下载链接');
    isDownloading = false;
    return;
  }

  if (failedNames.length > 0) {
    log('[V10-BATCH] ⚠️ 以下文件获取失败: ' + failedNames.join(', '));
  }

  updateBatchProgress(0, total, '开始下载...');
  showUserMessage('⏳ 正在下载 ' + files.length + ' 个文件到 "' + folderName + '/"...');

  const batchResult = await new Promise<BatchV10Response>((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'BATCH_DOWNLOAD_V10', files, folderName },
      (r: BatchV10Response) => resolve(r || { success: false, error: '无响应' })
    );
    setTimeout(() => resolve({ success: false, error: '批量下载超时(5min)' }), 300000);
  });

  if (batchResult.success && batchResult.results) {
    let okCount = 0;
    let failCount = 0;

    batchResult.results.forEach(r => {
      const ppt = ppts.find(p => r.filename.includes(p.title));
      if (ppt) {
        ppt.downloaded = r.success;
        updateSingleItemStatus(ppt, r.success);
        if (r.success) okCount++; else failCount++;
      }
    });

    const summary = '✅ 完成: ' + okCount + '成功 ' + failCount + '失败';
    updateBatchProgress(files.length, total, '完成');
    showUserMessage(summary);
    log('[V10-BATCH] ' + summary);
  } else {
    showUserMessage('❌ 批量下载失败: ' + (batchResult.error || '未知错误'));
    logErr('[V10-BATCH] 失败: ', batchResult.error);
  }
}

/** 统一入口：单个走saveAs:true弹框，多个走批量静默 */
async function enqueueBatchDownload(ppts: PPTResource[]): Promise<void> {
  if (isDownloading) { showUserMessage('正在下载中...'); return; }

  const pending = ppts.filter(p => !p.downloaded);
  if (pending.length === 0) { showUserMessage('没有待下载的PPT'); return; }

  isDownloading = true;

  if (pending.length === 1) {
    await downloadPPTFromContent(pending[0]);
    pending[0].downloaded = true;
    updateSingleItemStatus(pending[0], true);
  } else {
    await batchDownloadV10(pending);
  }

  isDownloading = false;
}

function updateSingleItemStatus(ppt: PPTResource, downloaded: boolean): void {
  const idx = detectedPPTs.findIndex(p => p.id === ppt.id);
  if (idx >= 0) {
    const btn = document.querySelector<HTMLButtonElement>(`button.download-single-btn[data-index="${idx}"]`);
    if (btn) { btn.textContent = downloaded ? '已下载' : '下载'; btn.disabled = downloaded; }
  }
}

// ============================================================
//  DOM 扫描器 — 多策略资源检测
// ============================================================

let detectedPPTs: PPTResource[] = [];

/** 扫描资料区 iframe 的 li.dataBody_file */
function scanDataBodyFiles(iframeDoc: Document, label: string): PPTResource[] {
  const results: PPTResource[] = [];
  const items = iframeDoc.querySelectorAll('li.dataBody_file');

  log(`[${label}] li.dataBody_file: ${items.length}个`);

  items.forEach((li, idx) => {
    const onclickAttr = li.getAttribute('onclick') || '';
    if (!onclickAttr) return;

    const params = parseToOpenParams(onclickAttr);
    if (!params) return;

    const fileType = params.dataType.toLowerCase();
    if (fileType !== 'ppt' && fileType !== 'pptx') return;

    log(`  [${label}] ${idx + 1}. [${fileType}] ${params.dataName}`);

    results.push({
      id: `data_${params.objectId}_${idx}`,
      title: params.dataName.replace(/\.(ppt|pptx)$/i, ''),
      url: `https://mooc1.chaoxing.com/ananas/status/${params.objectId}?flag=normal`,
      type: fileType as 'ppt' | 'pptx',
      courseId: params.classId,
      downloaded: false,
      meta: {
        dataId: params.dataId,
        objectId: params.objectId,
        classId: params.classId,
        enc: params.enc,
        t: params.t
      }
    });
  });

  return results;
}

/** 扫描传统 a 标签中的文件链接 */
function scanDocumentForLinks(doc: Document, label: string): PPTResource[] {
  const results: PPTResource[] = [];
  const selector = 'a[href*=".ppt"], a[href*=".pptx"], a[href*=".pdf"], a[href*=".mp4"], a[href*=".doc"], a[href*=".xls"]';
  const elements = doc.querySelectorAll(selector);

  log(`[${label}] 链接扫描: ${elements.length}个`);

  elements.forEach((el, idx) => {
    const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
    const title = el.textContent?.trim() || `文件_${idx + 1}`;
    const type = inferFileType(title);

    results.push({
      id: `link_${Date.now()}_${idx}`,
      title: title.replace(/\.\w+$/i, ''),
      url: href,
      type,
      downloaded: false
    });
  });

  return results;
}

/** API层获取（课程区域） */
async function fetchPPTFromAPI(): Promise<PPTResource[]> {
  const params = new URLSearchParams(window.location.search);
  const courseId = params.get('courseId') || params.get('courseid');
  if (!courseId) return [];

  try {
    const resp = await fetch(`https://mooc1.chaoxing.com/ananas/status/${courseId}?flag=normal`, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) return [];

    const data = await resp.json();
    if (!data?.data?.objectList) return [];

    return data.data.objectList
      .filter((item: { objectType?: string; property?: { ext?: string } }) =>
        item?.objectType === 'ppt' || item?.property?.ext?.match(/\.(ppt|pptx|pdf|mp4)$/i)
      )
      .map((item: { property?: { title?: string }; durl?: string; objectUrl?: string }, idx: number) => ({
        id: `api_${Date.now()}_${idx}`,
        title: item.property?.title || `API_文件_${idx + 1}`,
        url: item.durl || item.objectUrl || '',
        type: inferFileType(item.property?.title || ''),
        courseId,
        downloaded: false
      }));
  } catch (e) {
    logErr('[API] 错误:', e);
    return [];
  }
}

/** 主扫描入口：多策略组合 */
async function detectPPTResources(): Promise<PPTResource[]> {
  log('========== 开始扫描 ==========');
  const allPpts: PPTResource[] = [];

  // 1. 主页面链接
  allPpts.push(...scanDocumentForLinks(document, '主页'));

  // 2. 资料区 iframe
  const zlIframe = document.querySelector<HTMLIFrameElement>('#frame_content-zl');
  if (zlIframe) {
    try {
      const doc = zlIframe.contentWindow?.document;
      if (doc) {
        allPpts.push(...scanDataBodyFiles(doc, '资料区'));
        allPpts.push(...scanDocumentForLinks(doc, '资料区-链接'));
      }
    } catch (_e) { /* 跨域跳过 */ }
  }

  // 3. 其他 iframe
  document.querySelectorAll<HTMLIFrameElement>('iframe:not(#frame_content-zl)').forEach((iframe, idx) => {
    try {
      const doc = iframe.contentWindow?.document;
      if (doc) {
        const name = iframe.name || iframe.id || `iframe_${idx}`;
        allPpts.push(...scanDataBodyFiles(doc, name));
        allPpts.push(...scanDocumentForLinks(doc, name));
      }
    } catch (_e) { /* 跨域 */ }
  });

  // 4. API 层
  allPpts.push(...await fetchPPTFromAPI());

  // 去重
  const unique = [...new Map(allPpts.map(p => [p.url, p])).values()];
  log(`========== 完成: ${unique.length} 个唯一资源 ==========`);
  return unique;
}

// ============================================================
//  UI 层 — 浮动面板注入与交互
// ============================================================

let lastUrl = window.location.href;
let injected = false;
let observer: MutationObserver | null = null;

function destroyExistingUI(): void {
  const existing = document.getElementById(CONTAINER_ID);
  if (existing) { existing.remove(); injected = false; }
}

function createContainerUI(): HTMLDivElement {
  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.innerHTML = `
    <div class="ppt-downloader-header">
      <span class="ppt-downloader-title">📥 PPT下载器</span>
      <button id="ppt-close-btn" title="关闭">✕</button>
    </div>
    <div class="ppt-downloader-body">
      <button id="scan-ppt-btn" title="扫描当前页面的PPT">扫描PPT</button>
      <button id="download-all-btn" title="批量下载所有PPT" style="display:none;">批量下载 (0)</button>
      <div id="ppt-list-container" style="display:none;"></div>
    </div>
  `;
  return container;
}

function displayPPTList(ppts: PPTResource[]): void {
  detectedPPTs = ppts;
  const container = document.getElementById('ppt-list-container');
  if (!container) return;

  container.style.display = 'block';

  const titleEl = document.createElement('h4');
  titleEl.textContent = '📊 检测到 ' + ppts.length + ' 个资源';
  container.appendChild(titleEl);

  ppts.forEach((ppt, i) => {
    const item = document.createElement('div');
    item.className = 'ppt-item';
    item.dataset.index = String(i);

    const typeSpan = document.createElement('span');
    typeSpan.className = 'ppt-type';
    typeSpan.textContent = ppt.type.toUpperCase();

    const titleSpan = document.createElement('span');
    titleSpan.className = 'ppt-title';
    titleSpan.textContent = (i + 1) + '. ' + ppt.title;

    const btn = document.createElement('button');
    btn.className = 'download-single-btn';
    btn.dataset.index = String(i);
    btn.textContent = '下载';

    item.appendChild(typeSpan);
    item.appendChild(titleSpan);
    item.appendChild(btn);
    container.appendChild(item);

    btn.addEventListener('click', async () => {
      btn.textContent = '下载中...';
      btn.disabled = true;
      try {
        await downloadPPTFromContent(ppt);
        ppt.downloaded = true;
        btn.textContent = '已下载';
      } catch (err) {
        btn.textContent = '下载';
        btn.disabled = false;
        logErr('❌ ' + ppt.title + ':', err);
      }
    });
  });
}

function setupButtonHandlers(): void {
  document.getElementById('ppt-close-btn')?.addEventListener('click', destroyExistingUI);

  document.getElementById('scan-ppt-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('scan-ppt-btn') as HTMLButtonElement;
    btn.textContent = '扫描中...';
    btn.disabled = true;

    try {
      const ppts = await detectPPTResources();

      if (ppts.length > 0) {
        displayPPTList(ppts);
        const dlBtn = document.getElementById('download-all-btn');
        if (dlBtn) { dlBtn.style.display = 'inline-block'; dlBtn.textContent = `批量下载 (${ppts.length})`; }
        btn.textContent = `已发现 ${ppts.length} 个`;
        chrome.runtime.sendMessage({ type: 'PPT_LIST_RESULT', ppts });
      } else {
        warn('未发现资源');
        btn.textContent = '未发现PPT';
        setTimeout(() => { btn.textContent = '扫描PPT'; btn.disabled = false; }, 2000);
      }
    } catch (e) {
      logErr('扫描异常:', e);
      btn.textContent = '扫描出错';
      setTimeout(() => { btn.textContent = '扫描PPT'; btn.disabled = false; }, 2000);
    }
  });

  document.getElementById('download-all-btn')?.addEventListener('click', async () => {
    await enqueueBatchDownload(detectedPPTs);
  });
}

function injectDownloadButton(): void {
  if (window !== window.top) return;
  if (!isChaoxingHostname()) return;
  if (injected && document.getElementById(CONTAINER_ID)) return;

  log('注入UI');
  destroyExistingUI();
  document.body.appendChild(createContainerUI());
  injected = true;
  setupButtonHandlers();
}

// ============================================================
//  初始化
// ============================================================

if (window === window.top && isChaoxingHostname()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDownloadButton);
  } else {
    injectDownloadButton();
  }

  observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      destroyExistingUI();
      setTimeout(injectDownloadButton, 500);
    }
  });
  observer.observe(document.body, { childList: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PPT_LIST') {
    detectPPTResources().then(ppts => sendResponse({ ppts }));
    return true;
  }
});
