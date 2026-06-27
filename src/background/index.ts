import { PPTResource } from '../types';

// ===== 全局监听 =====

const BG_LOG_BUFFER: string[] = [];
const BG_LOG_MAX = 300;

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'interrupted') {
    log(`[下载事件] ❌ 中断: ${JSON.stringify(delta)}`);
  }
  if (delta.error) {
    log(`[下载事件] ❌ 错误: ${delta.error.current}`);
  }
});

// ===== 消息处理（仅保留 V10 稳定方案）=====

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 验证消息来源：仅允许来自超星域名或扩展自身页面
  const senderUrl = sender.url || '';
  const isAllowedOrigin = senderUrl.startsWith('https://mooc1.chaoxing.com') ||
                          senderUrl.startsWith('https://mooc1-1.chaoxing.com') ||
                          senderUrl.startsWith('https://mooc1-2.chaoxing.com') ||
                          senderUrl.startsWith('https://mooc2-ans.chaoxing.com') ||
                          senderUrl === ''; // 扩展内部消息（如popup）

  if (!isAllowedOrigin) {
    log(`[MSG] ❌ 拒绝非法来源: ${senderUrl}`);
    sendResponse({ success: false, error: '非法消息来源' });
    return false;
  }

  log(`[MSG] ${message.type} from ${senderUrl.substring(0, 50)}`);

  switch (message.type) {
    case 'FETCH_AND_DOWNLOAD_V10':
      handleSingleDownload(message.url, message.filename, sendResponse);
      return true;

    case 'BATCH_DOWNLOAD_V10':
      handleBatchDownload(message.files, message.folderName, sendResponse);
      return true;

    case 'RESOLVE_CDN_URL':
      resolveCdnUrl(message.objectId, message.classId, message.enc, message.t, message.referer || '', sendResponse);
      return true;

    case 'GET_LOGS':
      sendResponse({ logs: BG_LOG_BUFFER.slice() });
      return false;

    case 'CLEAR_LOGS':
      BG_LOG_BUFFER.length = 0;
      sendResponse({ success: true });
      return false;

    default:
      sendResponse({ success: false, error: `未知消息类型: ${message.type}` });
      return false;
  }
});

// ===== 核心下载逻辑 =====

/**
 * V10 单个文件下载
 * 流程: fetch CDN → Blob → data URL → chrome.downloads.download({saveAs:true})
 */
async function handleSingleDownload(
  cdnUrl: string,
  filename: string,
  sendResponse: (response: V10Response) => void
): Promise<void> {
  log(`[V10] 开始: ${filename}`);
  log(`[V10] URL: ${cdnUrl.substring(0, 120)}...`);

  let cookieHeader = '';
  try {
    const url = new URL(cdnUrl);
    const cookies = await chrome.cookies.getAll({ domain: url.hostname });
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch { /* ignore */ }

  try {
    const response = await fetch(cdnUrl, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
      }
    });

    log(`[V10] 响应: HTTP ${response.status}, type=${response.headers.get('content-type')}`);

    if (!response.ok) {
      sendResponse({ success: false, error: `HTTP ${response.status}`, httpStatus: response.status });
      return;
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      sendResponse({ success: false, error: '文件为空(0字节)' });
      return;
    }

    log(`[V10] Blob: size=${blob.size}, type=${blob.type}`);

    const dataUrl = await blobToDataUrl(blob);
    log(`[V10] Data URL 长度=${dataUrl.length}`);

    chrome.downloads.download({
      url: dataUrl,
      filename: sanitizeFilename(filename),
      saveAs: true,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message! });
      } else {
        sendResponse({ success: true, downloadId, blobSize: blob.size, blobType: blob.type });
      }
    });

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[V10] ❌ ${errMsg}`);
    sendResponse({ success: false, error: errMsg });
  }
}

/**
 * V10 批量下载
 * 流程: 逐个 fetch CDN → data URL → chrome.downloads.download({saveAs:false})
 */
async function handleBatchDownload(
  files: Array<{ cdnUrl: string; filename: string }>,
  folderName: string,
  sendResponse: (response: BatchV10Response) => void
): Promise<void> {
  log(`[V10-BATCH] 开始: ${files.length}个文件 → "${folderName}/"`);

  const results: Array<{ filename: string; success: boolean; error?: string }> = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < files.length; i++) {
    const { cdnUrl, filename } = files[i];
    log(`[V10-BATCH] (${i + 1}/${files.length}) ${filename}`);

    try {
      let cookieHeader = '';
      try {
        const url = new URL(cdnUrl);
        const cookies = await chrome.cookies.getAll({ domain: url.hostname });
        cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      } catch { /* ignore */ }

      const response = await fetch(cdnUrl, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
        }
      });

      if (!response.ok) {
        results.push({ filename, success: false, error: `HTTP ${response.status}` });
        failCount++;
        continue;
      }

      const blob = await response.blob();
      if (blob.size === 0) {
        results.push({ filename, success: false, error: '文件为空' });
        failCount++;
        continue;
      }

      const dataUrl = await blobToDataUrl(blob);
      const fullFilename = `${sanitizeFolderName(folderName)}/${sanitizeFilename(filename)}`;

      await new Promise<void>((resolve) => {
        chrome.downloads.download({
          url: dataUrl,
          filename: fullFilename,
          saveAs: false,
          conflictAction: 'uniquify'
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            results.push({ filename, success: false, error: chrome.runtime.lastError.message! });
            failCount++;
          } else {
            results.push({ filename, success: true });
            successCount++;
            log(`[V10-BATCH] ✅ ${filename} (id=${downloadId})`);
          }
          resolve();
        });
      });

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      results.push({ filename, success: false, error: errMsg });
      failCount++;
    }

    if (i < files.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  log(`[V10-BATCH] 完成: ✅${successCount} ❌${failCount}`);
  sendResponse({
    success: true,
    totalFiles: files.length,
    successCount,
    failCount,
    results
  });
}

// ===== 工具函数 =====

/**
 * 解析 status API,返回 CDN 直链（不受 CORS 限制,因在 background 中执行）
 * 优先级: pdf > download > preview
 */
async function resolveCdnUrl(
  objectId: string,
  classId: string,
  enc: string,
  t: string,
  referer: string,
  sendResponse: (response: ResolveCdnResponse) => void
): Promise<void> {
  const url = `https://mooc1.chaoxing.com/ananas/status/${objectId}?flag=normal`
    + (classId ? `&courseid=${classId}` : '')
    + (enc ? `&enc=${encodeURIComponent(enc)}` : '')
    + (t ? `&t=${t}` : '');

  log(`[Resolve] ${objectId} → ${url.substring(0, 100)}...`);

  // 思路:background fetch 强制带 Origin: chrome-extension://xxx,被服务器 403。
  // 唯一可行:在 mooc1 域名 tab 内,用 content 上下文 fetch(同源,Origin 正常)
  try {
    const result = await fetchViaMooc1Tab(url, 15000);
    if (result.success && result.data) {
      const data = result.data;
      const cdnUrl = (data.pdf || data.download || data.preview) as string | undefined;
      const isPdf = !!data.pdf;
      if (cdnUrl) {
        log(`[Resolve] ✅ ${objectId} → ${isPdf ? 'PDF' : 'CDN'} (via tab)`);
        sendResponse({ success: true, cdnUrl, isPdf });
        return;
      }
      log('[Resolve] ❌ 无 download/pdf/preview 字段');
      sendResponse({ success: false, error: 'status API 未返回 download/pdf/preview 字段' });
      return;
    }
    log(`[Resolve] ❌ tab fetch 失败: ${result.error}`);
    sendResponse({ success: false, error: result.error || 'tab fetch 失败' });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`[Resolve] ❌ ${errMsg}`);
    sendResponse({ success: false, error: errMsg });
  }
}

interface TabFetchResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** 找一个或新建一个 mooc1 域名 tab,让里面的 content 帮我们 fetch(同源绕开 Origin 限制) */
async function fetchViaMooc1Tab(url: string, timeoutMs: number): Promise<TabFetchResult> {
  let tab = (await chrome.tabs.query({ url: 'https://mooc1.chaoxing.com/*' }))[0];

  if (!tab) {
    log(`[Resolve-Tab] 没有 mooc1 tab, 新建一个`);
    try {
      tab = await chrome.tabs.create({
        url: 'https://mooc1.chaoxing.com/',
        active: false
      });
    } catch (e) {
      return { success: false, error: `无法创建 mooc1 tab: ${(e as Error).message}` };
    }
  } else {
    log(`[Resolve-Tab] 复用已有 mooc1 tab: ${tab.id}`);
  }

  if (!tab.id) return { success: false, error: 'tab 没有 id' };

  // 等 tab 加载完成
  const loaded = await waitTabLoad(tab.id, 8000);
  if (!loaded) return { success: false, error: 'mooc1 tab 加载超时' };

  // 让那个 tab 的 content 帮 fetch
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'FETCH_STATUS_API', url }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('tab sendMessage timeout')), timeoutMs)
      )
    ]);
    return result as TabFetchResult;
  } catch (e) {
    return { success: false, error: `sendMessage 失败: ${(e as Error).message}` };
  }
}

/** 等 tab 加载完成(轮询 status='complete') */
function waitTabLoad(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') resolve(true);
        else if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(check, 200);
      } catch {
        resolve(false);
      }
    };
    check();
  });
}

/** Blob → ArrayBuffer → base64 → data URL */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  
  let binaryStr = '';
  const chunkSize = 8192;
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const chunk = uint8Array.subarray(i, i + chunkSize);
    binaryStr += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  
  const base64 = btoa(binaryStr);
  return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

/**
 * 清理文件夹名中的非法字符
 * Chrome downloads API 不允许: \ / : * ? " < > |
 */
function sanitizeFolderName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
    .trim() || 'ChaoXing_Download';
}

/**
 * 清理文件名中的非法字符和路径遍历序列
 * 防止: ../etc/passwd, foo/../bar, //etc
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/\.{2,}/g, '')        // 去除连续点（防路径遍历）
    .replace(/[\\/]/g, '')         // 去除路径分隔符
    .replace(/[:*?"<>|]/g, '')     // 去除非法字符
    .replace(/^\s+|\s+$/g, '')    // 去除首尾空白
    .replace(/\.{2,}/g, '.')      // 再次去除连续点
    .trim() || 'untitled';
}

function log(msg: string): void {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  BG_LOG_BUFFER.push(line);
  if (BG_LOG_BUFFER.length > BG_LOG_MAX) BG_LOG_BUFFER.splice(0, BG_LOG_BUFFER.length - BG_LOG_MAX);
  console.log('%c[BG]', 'color: #28a745; font-weight: bold;', new Date().toLocaleTimeString(), msg);
}

// ===== 类型定义 =====

interface V10Response {
  success: boolean;
  error?: string;
  downloadId?: number;
  blobSize?: number;
  blobType?: string;
  httpStatus?: number;
}

interface BatchV10Response {
  success: boolean;
  totalFiles?: number;
  successCount?: number;
  failCount?: number;
  results?: Array<{ filename: string; success: boolean; error?: string }>;
  error?: string;
}

interface ResolveCdnResponse {
  success: boolean;
  cdnUrl?: string;
  isPdf?: boolean;
  error?: string;
}
