import { PPTResource, DownloadTask } from '../types';

let downloadTasks: Map<string, DownloadTask> = new Map();

// 全局监听下载事件，追踪错误
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state) {
    log(`[下载事件] id=${delta.id}, state=${delta.state.current}`);
    if (delta.state.current === 'interrupted') {
      log(`[下载事件] ❌ 中断原因: ${JSON.stringify(delta)}`);
    }
  }
  if (delta.error) {
    log(`[下载事件] ❌ 错误: ${delta.error.current}`);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('%c[BG-MSG]', 'color: #f00; font-weight: bold; font-size: 14px;', message.type, message);
  switch (message.type) {
    case 'DOWNLOAD_PPT_V3':
      // V3: Background执行所有网络操作（无CORS限制），获取Blob后通过chrome.downloads.download触发下载
      handleDownloadV3(message.ppt)
        .then(downloadId => sendResponse({ success: true, downloadId }))
        .catch(err => {
          log(`[V3] ❌ 错误: ${err.message || err}`);
          sendResponse({ success: false, error: err.message });
        });
      return true; // 保持消息通道开放

    case 'DOWNLOAD_PPT_V2':
      // 等handleDownloadV2真正完成后再sendResponse
      handleDownloadV2(message.ppt)
        .then(downloadId => sendResponse({ success: true, downloadId }))
        .catch(err => {
          log(`[V2] ❌ 错误: ${err.message || err}`);
          sendResponse({ success: false, error: err.message });
        });
      return true; // 保持消息通道开放
      break;

    case 'DOWNLOAD_DIRECT_URL':
      // Content script已解析好真实URL，直接同步调用chrome.downloads.download
      // 这是同步的，不会导致SW被杀
      log(`[下载] 收到DOWNLOAD_DIRECT_URL: ${message.filename}`);
      log(`[下载] url: ${message.url.substring(0, 120)}...`);
      chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: true,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          log(`[下载] ❌ chrome.downloads 错误: ${chrome.runtime.lastError.message}`);
        } else {
          log(`[下载] ✅ downloadId=${downloadId}`);
        }
      });
      sendResponse({ success: true });
      break;

    case 'TRIGGER_DOWNLOAD':
      // V7: Content script通过status API拿到download直链，让Background用chrome.downloads下载
      // 这个API会弹出"另存为"对话框，让用户选择保存位置
      log(`[TRIGGER_DL] 收到下载请求: ${message.filename}`);
      log(`[TRIGGER_DL] url: ${(message.url || '').substring(0, 120)}...`);
      chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: true,  // ← 弹出"另存为"对话框
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          log(`[TRIGGER_DL] ❌ 错误: ${chrome.runtime.lastError.message}`);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          log(`[TRIGGER_DL] ✅ downloadId=${downloadId}, 已弹出保存对话框`);
          sendResponse({ success: true, downloadId });
        }
      });
      return true; // 保持通道开放（sendResponse在回调中）

    case 'DOWNLOAD_BLOB_DATA':
      // V8: Content Script已经用fetch(带Cookie)拿到了文件Blob的base64数据
      // Background需要：base64 → Blob → Blob URL → chrome.downloads.download
      log(`[BLOB_DL] 收到Blob数据: filename=${message.filename}, base64长度=${message.base64?.length || 0}`);
      
      try {
        // 将base64转为Blob（二进制解码）
        const binaryStr = atob(message.base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        
        const blob = new Blob([bytes], { type: message.mimeType || 'application/octet-stream' });
        log(`[BLOB_DL] Blob创建成功: size=${blob.size}, type=${blob.type}`);
        
        // 创建Blob URL并触发下载
        const blobUrl = URL.createObjectURL(blob);
        
        chrome.downloads.download({
          url: blobUrl,
          filename: message.filename,
          saveAs: true,  // 弹出"另存为"对话框让用户选择位置
          conflictAction: 'uniquify'
        }, (downloadId) => {
          // 延迟释放Blob URL，确保下载开始后再清理
          setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
            log(`[BLOB_DL] Blob URL已释放`);
          }, 120000); // 2分钟后释放
          
          if (chrome.runtime.lastError) {
            log(`[BLOB_DL] ❌ chrome.downloads错误: ${chrome.runtime.lastError.message}`);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
          } else {
            log(`[BLOB_DL] ✅ downloadId=${downloadId}, 已弹出保存对话框`);
            sendResponse({ success: true, downloadId });
          }
        });
        
        return true; // 保持通道开放
        
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`[BLOB_DL] ❌ 处理失败: ${errMsg}`);
        sendResponse({ success: false, error: errMsg });
        return true;
      }

    case 'DOWNLOAD_BLOB_URL':
      // Content script already has the blob URL, just trigger download
      chrome.downloads.download({
        url: message.blobUrl,
        filename: `${message.title}.${message.ext}`,
        saveAs: true,
        conflictAction: 'uniquify'
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          log(`[下载] ❌ chrome.downloads 错误: ${chrome.runtime.lastError.message}`);
        } else {
          log(`[下载] ✅ downloadId=${downloadId}`);
        }
      });
      sendResponse({ success: true });
      break;

    // ===== V10: Background直接fetch CDN → Blob → chrome.downlands.download =====
    // 核心思路：
    //   1. Content Script在超星页面fetch status API（同域，不受CORS）拿到CDN直链
    //   2. 把CDN直链发给Background
    //   3. BG用fetch(CDN_URL, {credentials:'include'})直接下载文件（MV3 BG不受CORS限制）
    //   4. 拿到Blob后用chrome.downloads.download({saveAs:true})弹出保存对话框
    //
    // 前提条件：manifest.json的host_permissions必须包含 https://*.cldisk.com/*
    // 风险：CDN可能需要页面Cookie以外的鉴权（URL token等），导致403
    case 'FETCH_AND_DOWNLOAD_V10':
      (async () => {
        const { url: cdnUrl, filename } = message;
        log(`[V10] 开始BG fetch下载: ${filename}`);
        log(`[V10] CDN URL: ${cdnUrl.substring(0, 120)}...`);

        try {
          // ★ 关键：Background Service Worker 在 host_permissions 包含目标域名时，
          // fetch不受CORS限制，且credentials:'include'会携带Cookie
          const response = await fetch(cdnUrl, {
            method: 'GET',
            credentials: 'include',
            headers: {
              'Accept': '*/*',
              // 模拟浏览器请求头
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            }
          });

          log(`[V10] fetch响应: status=${response.status}, ok=${response.ok}`);
          log(`[V10] contentType=${response.headers.get('content-type')}`);
          log(`[V10] contentLength=${response.headers.get('content-length')}`);

          if (!response.ok) {
            // 读取错误响应体以便调试
            const errorText = await response.text().catch(() => '(无法读取)');
            log(`[V10] ❌ HTTP错误 ${response.status}: ${errorText.substring(0, 300)}`);
            sendResponse({ 
              success: false, 
              error: `HTTP ${response.status}: ${errorText.substring(0, 200)}`,
              httpStatus: response.status 
            });
            return;
          }

          // 获取Blob数据
          const blob = await response.blob();
          log(`[V10] Blob获取成功: size=${blob.size}, type=${blob.type}`);

          if (blob.size === 0) {
            sendResponse({ success: false, error: '文件为空(0字节)' });
            return;
          }

          // ★ V10.1 修复：SW环境没有URL.createObjectURL（无DOM）
          // 改用 data URL 方式：Blob → ArrayBuffer → base64 → data URI
          // chrome.downloads.download() 原生支持 data: URL
          const arrayBuffer = await blob.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          
          // 将字节转为base64（手动编码，避免依赖btoa的字符限制）
          let binaryStr = '';
          const chunkSize = 8192;
          for (let i = 0; i < uint8Array.length; i += chunkSize) {
            const chunk = uint8Array.subarray(i, i + chunkSize);
    binaryStr += String.fromCharCode.apply(null, chunk as unknown as number[]);
          }
          const base64 = btoa(binaryStr);
          
          // 根据MIME类型构建data URL
          const mimeType = blob.type || 'application/octet-stream';
          const dataUrl = `data:${mimeType};base64,${base64}`;
          log(`[V10] Data URL生成成功，长度=${dataUrl.length}`);

          chrome.downloads.download({
            url: dataUrl,
            filename: filename,
            saveAs: true,  // ← 弹出"另存为"对话框！
            conflictAction: 'uniquify'
          }, (downloadId) => {
            if (chrome.runtime.lastError) {
              log(`[V10] ❌ chrome.downloads错误: ${chrome.runtime.lastError.message}`);
              sendResponse({ 
                success: false, 
                error: `chrome.downloads失败: ${chrome.runtime.lastError.message}` 
              });
            } else {
              log(`[V10] ✅✅✅ downloadId=${downloadId}, 已弹出保存对话框！`);
              sendResponse({ 
                success: true, 
                downloadId,
                blobSize: blob.size,
                blobType: blob.type
              });
            }
          });

          // 注意：sendResponse在chrome.downloads回调中调用，这里不return

        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`[V10] ❌ 异常: ${errMsg}`);
          
          // 特别标记CORS相关错误
          if (errMsg.includes('Failed to fetch') || errMsg.includes('NetworkError')) {
            log(`[V10] ⚠️ 可能是CORS或网络问题 — 确认host_permissions是否包含cldisk.com`);
          }
          
          sendResponse({ success: false, error: errMsg });
        }
      })();
      return true; // 保持消息通道开放（sendResponse在async回调中）

    // ===== V10 批量下载：静默保存到子文件夹（不弹对话框）=====
    // 用途：用户点击"批量下载"时，所有文件自动下载到 Downloads/课程名/ 目录
    // 与单个下载的区别：saveAs=false + filename含子文件夹路径
    case 'BATCH_DOWNLOAD_V10':
      (async () => {
        const { files, folderName } = message;
        // files: Array<{cdnUrl: string, filename: string}>
        // folderName: 子文件夹名称（从页面标题提取的课程名）
        log(`[V10-BATCH] 开始批量下载: ${files.length}个文件 → 文件夹: ${folderName}`);

        const results: Array<{filename: string, success: boolean, error?: string}> = [];
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
              const err = `HTTP ${response.status}`;
              log(`[V10-BATCH] ❌ ${filename}: ${err}`);
              results.push({ filename, success: false, error: err });
              failCount++;
              continue;
            }

            const blob = await response.blob();
            if (blob.size === 0) {
              log(`[V10-BATCH] ❌ ${filename}: 文件为空`);
              results.push({ filename, success: false, error: '文件为空' });
              failCount++;
              continue;
            }

            // Blob → data URL（同V10.1的方案）
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            let binaryStr = '';
            const chunkSize = 8192;
            for (let j = 0; j < uint8Array.length; j += chunkSize) {
              const chunk = uint8Array.subarray(j, j + chunkSize);
              binaryStr += String.fromCharCode.apply(null, chunk as unknown as number[]);
            }
            const base64 = btoa(binaryStr);
            const mimeType = blob.type || 'application/octet-stream';
            const dataUrl = `data:${mimeType};base64,${base64}`;

            // ★ 关键：用子文件夹路径 + saveAs:false 实现静默下载
            const fullFilename = `${sanitizeFolderName(folderName)}/${filename}`;

            await new Promise<void>((resolveDownload) => {
              chrome.downloads.download({
                url: dataUrl,
                filename: fullFilename,
                saveAs: false,   // ← 静默！不弹对话框
                conflictAction: 'uniquify'
              }, (downloadId) => {
                if (chrome.runtime.lastError) {
                  log(`[V10-BATCH] ❌ ${filename}: ${chrome.runtime.lastError.message}`);
                  results.push({ filename, success: false, error: chrome.runtime.lastError.message });
                  failCount++;
                } else {
                  log(`[V10-BATCH] ✅ ${filename} → ${fullFilename} (id=${downloadId}, size=${blob.size})`);
                  results.push({ filename, success: true });
                  successCount++;
                }
                resolveDownload();
              });
            });

          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`[V10-BATCH] ❌ ${filename} 异常: ${errMsg}`);
            results.push({ filename, success: false, error: errMsg });
            failCount++;
          }

          // 每个文件之间间隔500ms，避免触发Chrome下载限速
          if (i < files.length - 1) {
            await new Promise(r => setTimeout(r, 500));
          }
        }

        log(`[V10-BATCH] 完成: ✅${successCount}成功 ❌${failCount}失败`);
        sendResponse({
          success: true,
          totalFiles: files.length,
          successCount,
          failCount,
          results
        });

      })();
      return true; // 保持消息通道开放

    case 'DOWNLOAD_PPT':
      // Content script已经解析好真实URL，我们直接调用chrome.downloads.download
      // 这是一个同步操作，不会导致SW被杀
      if (message.url && message.title) {
        const ext = message.type === 'pptx' ? 'pptx' : 'ppt';
        const filename = `${message.title}.${ext}`;
        log(`[下载] 收到真实URL，开始下载: ${filename}`);
        log(`[下载] url=${message.url.substring(0, 100)}...`);
        
        chrome.downloads.download({
          url: message.url,
          filename: filename,
          saveAs: true,
          conflictAction: 'uniquify'
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            log(`[下载] ❌ 失败: ${chrome.runtime.lastError.message}`);
          } else {
            log(`[下载] ✅ 已触发, downloadId=${downloadId}`);
          }
        });
        sendResponse({ success: true, downloadId: null });
      } else {
        // 旧格式：ppt对象（包含url字段是API端点）
        handleDownloadPPT(message.ppt).catch(err => {
          log(`[FATAL] Unhandled error in handleDownloadPPT: ${err.message || err}`);
        });
        sendResponse({ success: true });
      }
      break;

    case 'BATCH_DOWNLOAD':
      handleBatchDownload(message.ppts);
      sendResponse({ success: true });
      break;

    case 'GET_DOWNLOAD_STATUS':
      const task = downloadTasks.get(message.taskId);
      sendResponse(task || null);
      break;
  }
  return true;
});

async function handleDownloadPPT(ppt: PPTResource) {
  log(`[handleDownloadPPT] 开始处理: ${ppt.title}`);
  log(`[handleDownloadPPT] ppt.url = ${ppt.url}`);
  log(`[handleDownloadPPT] ppt.type = ${ppt.type}`);
  log(`[handleDownloadPPT] ppt.meta = ${JSON.stringify(ppt.meta)}`);
  
  const taskId = generateTaskId();
  const task: DownloadTask = {
    id: taskId,
    ppt,
    status: 'pending',
    progress: 0
  };

  downloadTasks.set(taskId, task);

  try {
    task.status = 'downloading';
    notifyProgress(taskId, 0, 'downloading');

    // 资料区PPT：URL是API端点，先获取JSON再提取真实下载URL
    let downloadUrl = ppt.url;
    log(`[下载] 初始URL: ${downloadUrl}`);
    if (ppt.url.includes('/ananas/status/')) {
      log(`[下载] 检测到资料区URL，先获取元数据: ${ppt.url}`);
      const metaResp = await fetch(ppt.url, { credentials: 'include' });
      log(`[下载] 元数据响应: status=${metaResp.status}, ok=${metaResp.ok}`);
      if (!metaResp.ok) throw new Error(`获取元数据失败: ${metaResp.status}`);
      const metaJson = await metaResp.json();
      log(`[下载] 元数据JSON keys: ${Object.keys(metaJson || {})}`);
      downloadUrl = metaJson?.data?.durl || metaJson?.data?.objectUrl;
      log(`[下载] 提取downloadUrl: ${downloadUrl || '(null)'}`);
      if (!downloadUrl) {
        log(`[下载] 完整元数据: ${JSON.stringify(metaJson).substring(0, 500)}`);
        throw new Error('未找到下载地址(durl)');
      }
    }

    log(`[下载] 开始fetch文件: ${downloadUrl}`);
    const response = await fetch(downloadUrl, {
      credentials: 'include'
    });
    log(`[下载] 文件响应: status=${response.status}, ok=${response.ok}, contentType=${response.headers.get('content-type')}`);

    if (!response.ok) {
      throw new Error(`下载失败: ${response.status}`);
    }

    const blob = await response.blob();
    log(`[下载] Blob获取: size=${blob.size}, type=${blob.type}`);
    task.progress = 50;
    notifyProgress(taskId, 50, 'downloading');

    const originalBlob = await ensureOriginalBlob(blob, ppt.type);
    log(`[下载] ensureOriginalBlob: size=${originalBlob.size}, type=${originalBlob.type}`);

    task.status = 'completed';
    task.progress = 100;
    notifyProgress(taskId, 100, 'completed');

    const ext = ppt.type === 'pptx' ? 'pptx' : 'ppt';
    const filename = `${ppt.title}.${ext}`;
    const blobUrl = URL.createObjectURL(originalBlob);
    log(`[下载] blobUrl = ${blobUrl}`);
    log(`[下载] 调用 chrome.downloads.download: filename=${filename}`);
    
    chrome.downloads.download({
      url: blobUrl,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        log(`[下载] ❌ chrome.downloads.download 错误: ${chrome.runtime.lastError.message}`);
      } else {
        log(`[下载] chrome.downloads.download 成功, downloadId=${downloadId}`);
      }
    });

    ppt.downloaded = true;
    showNotification(`${ppt.title} 下载完成！`, 'success');

  } catch (error) {
    task.status = 'error';
    task.error = error instanceof Error ? error.message : '未知错误';
    log(`[下载] ❌ 异常: ${task.error}`);
    showNotification(`下载失败: ${task.error}`, 'error');
  }
}

function log(msg: string) {
  console.log(`%c[PPT-Downloader]`, 'color: #28a745; font-weight: bold;', new Date().toLocaleTimeString(), msg);
}

/**
 * V3下载流程 — 完全在Background中执行，无CORS限制
 * 
 * 流程:
 * 1. fetch 元数据API（获取durl真实下载地址）— Background不受CORS限制
 * 2. fetch 文件Blob（从durl下载实际文件）
 * 3. 创建Blob URL + chrome.downloads.download 触发浏览器原生下载
 */
async function handleDownloadV3(ppt: PPTResource): Promise<number> {
  log(`[V3] 开始处理: ${ppt.title}`);
  log(`[V3] 初始url=${ppt.url.substring(0, 120)}...`);

  // 第一步：解析真实下载URL
  let downloadUrl = ppt.url;
  if (ppt.url.includes('/ananas/status/')) {
    log(`[V3] 获取元数据: ${ppt.url}`);
    try {
      const metaResp = await fetch(ppt.url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      log(`[V3] 元数据响应: HTTP ${metaResp.status}`);
      if (!metaResp.ok) throw new Error(`元数据请求失败 HTTP ${metaResp.status}`);
      
      const metaJson = await metaResp.json();
      log(`[V3] JSON keys: ${Object.keys(metaJson || {}).join(',')}`);
      downloadUrl = metaJson?.data?.durl || metaJson?.data?.objectUrl;
      
      if (!downloadUrl) {
        log(`[V3] 完整响应: ${JSON.stringify(metaJson).slice(0, 500)}`);
        throw new Error('未找到下载地址(durl)');
      }
      log(`[V3] durl=${downloadUrl.substring(0, 120)}...`);
    } catch (err) {
      log(`[V3] ❌ 获取元数据失败: ${(err as Error).message}`);
      throw err;
    }
  }

  // 第二步：fetch文件Blob
  log(`[V3] 下载文件...`);
  let blob: Blob;
  try {
    const fileResp = await fetch(downloadUrl, { credentials: 'include' });
    log(`[V3] 文件响应: HTTP ${fileResp.status}, contentType=${fileResp.headers.get('content-type')}`);
    if (!fileResp.ok) throw new Error(`文件下载失败 HTTP ${fileResp.status}`);
    
    blob = await fileResp.blob();
    log(`[V3] Blob: size=${blob.size}, type=${blob.type}`);
    if (blob.size === 0) throw new Error('文件为空(0字节)');
  } catch (err) {
    log(`[V3] ❌ 下载文件失败: ${(err as Error).message}`);
    throw err;
  }

  // 第三步：通过chrome.downloads.download触发下载
  const ext = ppt.type === 'pptx' ? 'pptx' : 'ppt';
  const filename = `${ppt.title}.${ext}`;
  const blobUrl = URL.createObjectURL(blob);
  
  log(`[V3] 触发下载: ${filename}`);

  return new Promise<number>((resolve, reject) => {
    chrome.downloads.download({
      url: blobUrl,
      filename: filename,
      saveAs: false,  // 静默下载，不弹对话框
      conflictAction: 'uniquify'
    }, (downloadId) => {
      // 延迟清理blob URL（确保下载开始后再释放）
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      
      if (chrome.runtime.lastError) {
        log(`[V3] ❌ chrome.downloads错误: ${chrome.runtime.lastError.message}`);
        reject(new Error(chrome.runtime.lastError.message!));
      } else {
        log(`[V3] ✅ downloadId=${downloadId}`);
        ppt.downloaded = true;
        showNotification(`${ppt.title} 下载已开始`, 'success');
        resolve(downloadId!);
      }
    });
  });
}

async function handleDownloadV2(ppt: PPTResource): Promise<number> {
  log(`[V2] 开始处理: ${ppt.title}`);
  log(`[V2] url=${ppt.url}`);
  
  let downloadUrl = ppt.url;
  
  if (ppt.url.includes('/ananas/status/')) {
    log(`[V2] 获取元数据...`);
    const metaResp = await fetch(ppt.url, { credentials: 'include' });
    log(`[V2] HTTP ${metaResp.status}`);
    if (!metaResp.ok) throw new Error(`HTTP ${metaResp.status}`);
    const metaJson = await metaResp.json();
    log(`[V2] JSON keys=${Object.keys(metaJson || {}).join(',')}`);
    downloadUrl = metaJson?.data?.durl || metaJson?.data?.objectUrl;
    if (!downloadUrl) {
      log(`[V2] 完整响应: ${JSON.stringify(metaJson).slice(0, 400)}`);
      throw new Error('无durl');
    }
    log(`[V2] durl=${downloadUrl.substring(0, 120)}...`);
  }
  
  const ext = ppt.type === 'pptx' ? 'pptx' : 'ppt';
  const filename = `${ppt.title}.${ext}`;
  log(`[V2] 调用chrome.downloads.download: ${filename}`);
  
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: downloadUrl,
      filename: filename,
      saveAs: true,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        log(`[V2] ❌ ${chrome.runtime.lastError.message}`);
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        log(`[V2] ✅ downloadId=${downloadId}`);
        ppt.downloaded = true;
        showNotification(`${ppt.title} 下载已开始`, 'success');
        resolve(downloadId);
      }
    });
  });
}

async function handleBatchDownload(ppts: PPTResource[]) {
  log(`[批量] 开始下载 ${ppts.length} 个文件 (V3流程)`);
  for (const ppt of ppts) {
    if (!ppt.downloaded) {
      try {
        await handleDownloadV3(ppt);
        // 每个下载之间间隔1秒，避免触发限速
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        log(`[批量] ❌ ${ppt.title} 跳过: ${(err as Error).message}`);
        // 继续下一个
      }
    }
  }
  showNotification(`批量下载完成！共 ${ppts.length} 个文件`, 'success');
}

/**
 * 当前策略：直接透传原始PPT/PPTX Blob，保留真实文件扩展名。
 *
 * === 未来PDF转换Workflow接口（预留） ===
 * 浏览器环境无法原生解析PPTX（OpenXML格式），需借助外部服务：
 *
 *   A. 云端API — CloudConvert / ConvertAPI（需用户在设置页配置API Key）
 *      流程：上传PPTX → 云端LibreOffice转换 → 下载PDF Blob
 *      免费额度：CloudConvert 25次/天, ConvertAPI 250次/月
 *
 *   B. 本地LibreOffice — 扩展通过 localhost 与本地 headless 进程通信
 *      流程：POST PPTX 到 http://localhost:port/convert → 接收PDF
 *      优点：无云端依赖、无限次转换
 *      缺点：需用户预先安装并启动 LibreOffice
 *
 *   C. WASM方案 — WebAssembly版LibreOffice（包体>200MB，不推荐浏览器扩展场景）
 *
 * 预留接口签名：
 *   async function convertPPTtoPDF(
 *     blob: Blob,
 *     title: string,
 *     provider: 'cloud' | 'local'
 *   ): Promise<Blob>
 *
 * 集成点：在 handleDownloadPPT 中，将 ensureOriginalBlob 替换为 convertPPTtoPDF，
 * 并将下载扩展名从 .pptx/.ppt 改为 .pdf。
 */

async function ensureOriginalBlob(blob: Blob, type: 'ppt' | 'pptx'): Promise<Blob> {
  // 当前直接返回原始blob；服务器可能返回application/octet-stream等非标准MIME类型
  if (blob.type.startsWith('application/')) {
    return blob;
  }
  // 兜底：强制标记为正确的MIME类型
  const mime = type === 'pptx'
    ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    : 'application/vnd.ms-powerpoint';
  return new Blob([blob], { type: mime });
}

function notifyProgress(taskId: string, progress: number, status: DownloadTask['status']) {
  chrome.runtime.sendMessage({
    type: 'DOWNLOAD_PROGRESS',
    taskId,
    progress,
    status
  }).catch(() => {});
}

function showNotification(message: string, notificationType: 'success' | 'error' | 'info') {
  chrome.runtime.sendMessage({
    type: 'SHOW_NOTIFICATION',
    message,
    notificationType
  }).catch(() => {});
}

function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 清理文件夹/文件名中的非法字符
 * Chrome downloads API 的 filename 不允许: \ / : * ? " < > | 等字符
 * 同时移除首尾空格和点号
 */
function sanitizeFolderName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')   // 移除非法字符
    .replace(/^\s+|\s+$/g, '')       // 去首尾空格
    .replace(/^\.+|\.+$/g, '')       // 去首尾点号
    .replace(/\.{2,}/g, '.')         // 多个连续点变单点
    .trim() || 'ChaoXing_Download';  // 空名兜底
}
