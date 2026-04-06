import { PPTResource } from '../types';

// ===== 全局监听 =====

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'interrupted') {
    log(`[下载事件] ❌ 中断: ${JSON.stringify(delta)}`);
  }
  if (delta.error) {
    log(`[下载事件] ❌ 错误: ${delta.error.current}`);
  }
});

// ===== 消息处理（仅保留 V10 稳定方案）=====

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  log(`[MSG] ${message.type}`);

  switch (message.type) {
    case 'FETCH_AND_DOWNLOAD_V10':
      handleSingleDownload(message.url, message.filename, sendResponse);
      return true;

    case 'BATCH_DOWNLOAD_V10':
      handleBatchDownload(message.files, message.folderName, sendResponse);
      return true;

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

  try {
    const response = await fetch(cdnUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }
    });

    log(`[V10] 响应: HTTP ${response.status}, type=${response.headers.get('content-type')}`);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '(无法读取)');
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
      filename,
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
      const response = await fetch(cdnUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
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
      const fullFilename = `${sanitizeFolderName(folderName)}/${filename}`;

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
 * 清理文件夹/文件名中的非法字符
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

function log(msg: string): void {
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
