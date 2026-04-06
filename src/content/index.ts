import { PPTResource } from '../types';

const CHAOXING_DOMAINS = [
  'mooc1.chaoxing.com',
  'mooc1-1.chaoxing.com',
  'mooc1-2.chaoxing.com',
  'mooc2-ans.chaoxing.com'
];

// ===== 轻量日志系统 =====
const LOG_PREFIX = '%c[PPT-Downloader]';
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

function isChaoxingHostname(): boolean {
  return CHAOXING_DOMAINS.some(domain => 
    window.location.hostname.includes(domain)
  );
}

// ===== PPT资源检测 =====

/** 解析 toOpen() 函数调用参数 */
interface ToOpenParams {
  dataName: string;
  dataType: string;
  dataId: string;
  objectId: string;
  classId: string;
  enc: string;
  t: string;
  rawOnclick: string;
}

function parseToOpenParams(onclickAttr: string): ToOpenParams | null {
  // 清理：把多行/多余空白压缩为单个空格
  const cleaned = onclickAttr.replace(/\s+/g, ' ').trim();
  
  // toOpen('filename','type',dataId,'',objectId,'',flag,source,classId,enc,'',t,'')
  // 实际调用只有13个参数。用更宽松的正则匹配。
  // 策略：先提取 toOpen(...) 内容，再分割参数
  const outerMatch = /toOpen\((.+)\)/.exec(cleaned);
  if (!outerMatch) {
    console.log(`[PPT-DEBUG] 无法提取toOpen内容, onclick前200字符: ${cleaned.substring(0, 200)}`);
    return null;
  }
  
  // 提取括号内内容，按 ',' 分割（但要注意引号内的逗号不能分割）
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
  if (current.trim()) {
    params.push(current.trim());
  }
  
  if (params.length < 13) {
    console.log(`[PPT-DEBUG] 参数数量不足: 期望>=13, 实际=${params.length}`);
    console.log(`[PPT-DEBUG] 参数列表:`, params);
    return null;
  }
  
  // 清理引号: 'value' -> value
  const p = params.map(s => s.replace(/^'|'$/g, ''));
  
  // p[0]=filename, p[1]=type, p[2]=dataId, p[3]='', p[4]=objectId,
  // p[5]='', p[6]=flag, p[7]=source, p[8]=classId, p[9]=enc,
  // p[10]='', p[11]=t, p[12]=bookEnc, p[13]=isDownload(可选)
  
  return {
    dataName: decodeURIComponent(p[0]),
    dataType: p[1],
    dataId: p[2],
    objectId: p[4],
    classId: p[8],
    enc: p[9],
    t: p[11],
    rawOnclick: onclickAttr
  };
}

/**
 * V10 下载策略 — "CS fetch status → BG fetch CDN Blob → chrome.downloads" 模式
 * 
 * 核心流程：
 * 1. Content Script fetch status API（同域mooc1.chaoxing.com，不受CORS）
 *    → 从JSON中提取CDN直链（pdf字段 s3.cldisk.com）
 * 2. 把CDN直链发送给 Background Service Worker
 * 3. BG用fetch(CDN_URL, {credentials:'include'})直接下载文件
 *    - MV3 BG不受CORS限制（扩展特权 + host_permissions声明了cldisk.com）
 *    - BG的fetch携带Cookie/鉴权信息
 * 4. BG拿到Blob后调用chrome.downloads.download({saveAs:true})
 *    → 弹出Chrome原生"另存为"对话框！✅✅✅
 * 
 * V10是最终方案：如果BG fetch也失败(403/CORS)，fallback到V9.4的<a>标签导航
 */
async function downloadPPTFromContent(ppt: PPTResource): Promise<void> {
  log(`[V10] 开始: ${ppt.title}`);
  
  const meta = ppt.meta || {};
  const candidateUrls = buildCandidateUrls(meta);
  log(`[V10] 候选URL数量: ${candidateUrls.length}`);
  
  for (let i = 0; i < candidateUrls.length; i++) {
    const urlInfo = candidateUrls[i];
    log(`[V10] 尝试方案${i + 1}: ${urlInfo.method} → ${urlInfo.url.substring(0, 120)}...`);
    
    try {
      if (urlInfo.method === 'status_fetch') {
        // ★ 核心方案：直接fetch status API（同域请求不受CORS）
        const result = await fetchStatusAndGetDownloadUrl(urlInfo.url);
        if (result) {
          const { url: downloadUrl, isPdf } = result;
          log(`[V10] ✅ 拿到直链, 准备走V10流程: ${downloadUrl.substring(0, 80)}... (isPdf=${isPdf})`);
          
          // V10: 根据实际文件类型决定扩展名
          const ext = isPdf ? 'pdf' : (ppt.type === 'pptx' ? 'pptx' : 'ppt');
          const filename = `${ppt.title}.${ext}`;
          
          // ★ V10主路径：发给Background去fetch+download
          const v10Result = await sendToBackgroundV10(downloadUrl, filename);
          
          if (v10Result.success) {
            // V10成功！Chrome已弹出保存对话框
            ppt.downloaded = true;
            showUserMessage(`${ppt.title} 已弹出保存对话框！请选择保存位置`);
            log(`[V10] ✅✅✅ V10成功! downloadId=${v10Result.downloadId}, blobSize=${v10Result.blobSize}`);
            return;
          } else {
            // V10失败 — 打印详细错误并fallback到V9.4导航方式
            log(`[V10] ⚠️ V10失败: ${v10Result.error} (httpStatus=${v10Result.httpStatus || 'N/A'})`);
            
            if (v10Result.httpStatus === 403) {
              log(`[V10] 403说明CDN鉴权失败(BG无有效Cookie/token)，fallback到V9.4导航`);
              showUserMessage(`${ppt.title}: CDN鉴权失败，使用备用方案`);
            } else {
              showUserMessage(`${ppt.title}: V10失败(${(v10Result.error || '未知').substring(0,50)})，尝试备用方案`);
            }
            
            // Fallback: V9.4 导航方式（新标签页打开）
            navigateToDownload(downloadUrl, filename);
            ppt.downloaded = true;
            return;
          }
        } else {
          log(`[V10] 方案${i + 1}: 未从status获取到download链接`);
        }
      } else if (urlInfo.method === 'open_window') {
        log(`[V10] 打开预览窗口: ${ppt.title}`);
        const newWin = window.open(urlInfo.url, '_blank');
        if (newWin) {
          ppt.downloaded = true;
          showUserMessage(`${ppt.title} 已在新窗口打开，请 Ctrl+S 保存`);
          return;
        }
      } else if (urlInfo.method === 'direct_download') {
        const ext = ppt.type === 'pptx' ? 'pptx' : 'ppt';
        navigateToDownload(urlInfo.url, `${ppt.title}.${ext}`);
        ppt.downloaded = true;
        log(`[V10] ✅ 直接触发导航下载(fallback)`);
        showUserMessage(`${ppt.title} 下载已触发！`);
        return;
      }
    } catch (e) {
      log(`[V10] 方案${i + 1} 异常: ${(e as Error).message}`);
      continue;
    }
  }
  
  // 所有方案都失败，最终兜底
  log(`[V10] 最终兜底: 调用toOpen()`);
  try {
    invokeOriginalToOpen(ppt);
    showUserMessage(`${ppt.title}: 已调用原页面打开方式`);
    ppt.downloaded = true;
  } catch (e) {
    throw new Error(`所有下载方式均失败: ${(e as Error).message}`);
  }
}

/** V10消息响应结构 */
interface V10Response {
  success: boolean;
  error?: string;
  downloadId?: number;
  blobSize?: number;
  blobType?: string;
  httpStatus?: number;
}

/**
 * V10核心：把CDN直链发给Background，让BG去fetch文件并触发chrome.downloads.download
 * @param cdnUrl CDN直链接(s3.cldisk.com或d0.cldisk.com)
 * @param filename 建议保存的文件名
 * @returns V10结果
 */
function sendToBackgroundV10(cdnUrl: string, filename: string): Promise<V10Response> {
  return new Promise((resolve) => {
    log(`[V10→BG] 发送FETCH_AND_DOWNLOAD_V10: ${filename}`);
    log(`[V10→BG] URL: ${cdnUrl.substring(0, 100)}...`);
    
    chrome.runtime.sendMessage({
      type: 'FETCH_AND_DOWNLOAD_V10',
      url: cdnUrl,
      filename: filename
    }, (response: V10Response) => {
      if (response) {
        log(`[V10←BG] 收到响应: success=${response.success}, error=${response.error}, httpStatus=${response.httpStatus}`);
      } else {
        log(`[V10←BG] 无响应(超时?)`);
      }
      resolve(response || { success: false, error: '无响应（可能SW超时）' });
    });
    
    // 30秒超时保护
    setTimeout(() => {
      resolve({ success: false, error: 'Background响应超时(30s)' });
    }, 30000);
  });
}

/** status API返回的JSON结构 */
interface StatusApiResponse {
  download?: string;
  filename?: string;
  pdf?: string;
  preview?: string;
  status?: string;
  [key: string]: unknown;
}

/** 用fetch直接请求status API并解析出download/pdf直链 */
interface FetchResult {
  url: string;
  isPdf: boolean;  // true=pdf链接, false=download链接
}
async function fetchStatusAndGetDownloadUrl(statusUrl: string): Promise<FetchResult | null> {
  try {
    log(`[statusFetch] 开始fetch: ${statusUrl.substring(0, 100)}...`);
    
    const response = await fetch(statusUrl, {
      method: 'GET',
      credentials: 'include', // 携带Cookie
      headers: {
        'Accept': 'application/json, text/plain, */*'
      }
    });
    
    log(`[statusFetch] 响应状态: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      log(`[statusFetch] HTTP错误: ${response.status}`);
      return null;
    }
    
    const text = await response.text();
    log(`[statusFetch] 响应体长度: ${text.length}, 前200字符: ${text.substring(0, 200)}`);
    
    if (!text || text.length < 5) {
      log(`[statusFetch] 响应体为空或太短`);
      return null;
    }
    
    const data = JSON.parse(text) as StatusApiResponse;
    
    // ★ 打印完整JSON以便调试（看看有哪些字段可用）
    log(`[statusFetch] 完整JSON keys: ${Object.keys(data).join(', ')}`);
    log(`[statusFetch] 完整JSON(前500字符): ${text.substring(0, 500)}`);
    log(`[statusFetch] JSON解析成功, status=${data.status}, hasDownload=!!${data.download}, filename=${data.filename}, hasPreview=!!${data.preview}, hasPdf=!!${data.pdf}`);
    
    // ★ V9.3策略变更: pdf链接(s3.cldisk.com)比download链接(d0.cldisk.com)更可靠!
    // 实测发现:
    //   - download字段(d0.cldisk.com/download/...) → 经常403 Forbidden "Invalid Request"
    //   - pdf字段(s3.cldisk.com/sv-w8/doc/.../pdf/...) → 可直接访问，返回真实PDF文件
    // 原因推测: 超星教师端上传的ppt/pptx在后台被转换为pdf存储，download链可能有防盗链时效性
    
    // 1. 优先使用 pdf 链接（最可靠）
    if (data.pdf) {
      log(`[statusFetch] ★ 使用pdf链接(最可靠): ${data.pdf.substring(0, 80)}...`);
      return { url: data.pdf, isPdf: true };
    }
    
    // 2. 其次尝试 download 链接
    if (data.download) {
      log(`[statusFetch] 使用download链接(可能403): ${data.download.substring(0, 80)}...`);
      return { url: data.download, isPdf: false };
    }
    
    // 3. 尝试preview字段
    if (data.preview) {
      log(`[statusFetch] 无download/pdf字段，使用preview链接`);
      return { url: data.preview, isPdf: false };
    }
    
    log(`[statusFetch] JSON中没有任何可用的下载链接`);
    return null;
    
  } catch (e) {
    const err = e as Error;
    log(`[statusFetch] 错误: ${err.message}`);
    
    // 如果是CORS错误，特别标记一下
    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      log(`[statusFetch] ⚠️ 可能被CORS拦截或网络错误`);
    }
    
    return null;
  }
}

/** 构造多种候选下载/预览URL */
function buildCandidateUrls(meta: Record<string, string>): Array<{method: string, url: string}> {
  const urls: Array<{method: string, url: string}> = [];
  const { objectId, dataId, classId, enc, t } = meta;
  
  if (!objectId) return urls;
  
  // 1. ★ ananas/status — 返回JSON含download直链（核心方案）
  let statusUrl = `https://mooc1.chaoxing.com/ananas/status/${objectId}?flag=normal`;
  if (classId) statusUrl += `&courseid=${classId}`;
  if (enc) statusUrl += `&enc=${encodeURIComponent(enc)}`;
  if (t) statusUrl += `&t=${t}`;
  urls.push({ method: 'status_fetch', url: statusUrl });
  
  // 2. ans-attachment 域的status（同域可能更好）
  if (classId && enc && t) {
    const altStatusUrl = `https://mooc2-ans.chaoxing.com/ananas/status/${objectId}?flag=normal&courseid=${classId}&enc=${encodeURIComponent(enc)}&t=${t}`;
    urls.push({ method: 'status_fetch', url: altStatusUrl });
  }
  
  // 3. 预览链接（fallback）
  const previewUrl = `https://mooc1.chaoxing.com/ananas/preview/${objectId}?courseid=${classId || ''}`;
  urls.push({ method: 'open_window', url: previewUrl });
  
  // 4. 直接附件下载
  if (enc && t) {
    const attachUrl = `https://ans-attachment.chaoxing.com/full/${objectId}?courceid=${classId || ''}&enc=${encodeURIComponent(enc)}&t=${t}`;
    urls.push({ method: 'direct_download', url: attachUrl });
  }
  
  return urls;
}

/** 用隐藏iframe加载URL并提取其中的图片 */
async function extractImagesFromUrl(url: string): Promise<string[]> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;';
    iframe.src = url;
    iframe.sandbox = 'allow-same-origin allow-scripts';
    
    const images: string[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      resolve(images); // 返回已找到的（可能有0个）
    }, 15000); // 15秒超时
    
    function cleanup() {
      clearTimeout(timeout);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }
    
    iframe.onload = () => {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          // 提取所有<img>标签的src
          const imgs = doc.querySelectorAll('img[src]');
          imgs.forEach(img => {
            const src = (img as HTMLImageElement).src;
            if (src && !src.startsWith('data:') && (src.includes('.jpg') || src.includes('.png') || src.includes('jpeg') || src.includes('image') || src.includes('ananas'))) {
              images.push(src);
            }
          });
          
          // 也检查canvas或背景图
          const allElements = doc.querySelectorAll('[style*="background-image"], [style*="background"]');
          allElements.forEach(el => {
            const style = el.getAttribute('style') || '';
            const match = /url\(["']?(.*?)["']?\)/.exec(style);
            if (match?.[1]) images.push(match[1]);
          });
          
          log(`[extractImages] 找到 ${images.length} 个图片`);
        }
      } catch (e) {
        log(`[extractImages] 跨域限制: ${(e as Error).message}`);
      }
      cleanup();
      resolve(images);
    };
    
    iframe.onerror = () => {
      log(`[extractImages] iframe加载失败`);
      cleanup();
      resolve(images);
    };
    
    document.body.appendChild(iframe);
  });
}

/** 逐个触发图片下载 */
async function downloadImages(imageUrls: string[], title: string): Promise<void> {
  for (let i = 0; i < imageUrls.length; i++) {
    const filename = `${title}_page${i + 1}.png`;
    navigateToDownload(imageUrls[i], filename);
    // 间隔500ms避免浏览器阻止
    await new Promise(r => setTimeout(r, 500));
  }
}

/**
 * V9.2核心：直接让当前页面导航到CDN直链
 * 
 * V9.1的iframe方案被CDN 403拒绝 — "Invalid Request" / 防盗链检查
 * 
 * 关键发现：
 * - CDN(cldisk.com)可能检查 Referer 头，iframe的Referer是当前超星页面（理论上应该OK）
 * - 但也可能检查其他东西：请求来源是否为"用户主动点击"
 * - iframe/隐藏导航可能被CDN识别为非正常下载行为
 * 
 * V9.2策略：直接用 window.location.href / location.assign() 让页面本身跳转到CDN
 * - 这是最接近"用户手动点击下载链接"的行为
 * - Referer正确、Cookie完整、请求头完全一致
 * - 缺点：用户会离开当前页面（但PPT文件应该触发下载而非显示）
 */
function navigateToDownload(url: string, filename: string): void {
  log(`[navigateDL V9.4] 触发下载: ${filename}`);
  log(`[navigateDL V9.4] URL: ${url.substring(0, 120)}...`);

  // 创建隐藏的 <a> 标签
  const link = document.createElement('a');
  link.href = url;
  // ★ 不设 download 属性！跨域URL的download属性被浏览器静默忽略
  //   不设反而让服务端 Content-Disposition 控制（如果有）
  link.target = '_blank';      // 新标签页打开，不影响当前页面
  link.rel = 'noopener noreferrer';  // 安全性

  // 隐藏这个标签
  link.style.cssText = 'position:absolute;left:-9999px;top:-9999px;opacity:0;pointer-events:none;';

  document.body.appendChild(link);

  // 程序化点击 — 浏览器会将其视为"用户主动点击链接"
  try {
    link.click();
    log(`[navigateDL V9.4] ✅ link.click() 已触发, 应该在新标签页打开/下载`);

    // 延迟移除DOM元素（确保点击事件已处理）
    setTimeout(() => {
      if (link.parentNode) link.parentNode.removeChild(link);
    }, 1000);
  } catch (e) {
    logErr(`[navigateDL V9.4] click失败: ${(e as Error).message}, 尝试window.open`);
    const newWin = window.open(url, '_blank');
    if (!newWin) {
      showUserMessage('弹出窗口被拦截，请允许弹窗后重试');
    }
    if (link.parentNode) link.parentNode.removeChild(link);
  }
}

// ===== 批量下载 =====

/** 批量下载锁 */
let isDownloading = false;

/**
 * 从页面提取课程/章节名称，用作下载子文件夹名
 * 优先级：页面h1/h2/h3标题 > document.title > URL参数 > 兜底
 */
function extractCourseFolderName(): string {
  // 1. 尝试页面主标题
  const h1 = document.querySelector('h1, h2, h3');
  if (h1?.textContent?.trim()) {
    const name = h1.textContent.trim();
    log(`[folderName] 从标题元素提取: ${name}`);
    return name;
  }

  // 2. document.title (通常格式: "课程名 - 学习通" 或类似)
  const title = document.title.trim();
  if (title) {
    // 去掉常见的后缀
    const cleaned = title
      .replace(/\s*[-|–—]\s*(超星|学习通|ChaoXing|mooc|在线学习|教学平台).*$/i, '')
      .trim();
    if (cleaned) {
      log(`[folderName] 从document.title提取: ${cleaned} (原标题: ${title})`);
      return cleaned;
    }
  }

  // 3. 从URL的courseid附近提取（不太可靠但兜底）
  log(`[folderName] 使用兜底名称`);
  return 'ChaoXing_PPT';
}

/** V10批量下载响应结构 */
interface BatchV10Response {
  success: boolean;
  totalFiles?: number;
  successCount?: number;
  failCount?: number;
  results?: Array<{filename: string, success: boolean, error?: string}>;
  error?: string;
}

/**
 * V10批量下载核心流程：
 * 1. 对每个PPT先 fetch status API 拿到CDN直链
 * 2. 把所有 {cdnUrl, filename} + folderName 打包发给 BG
 * 3. BG逐个 fetch → data URL → chrome.downloads.download(saveAs:false, filename含子文件夹)
 *
 * 与单个下载的区别：
 *   - 单个: saveAs:true 弹出对话框
 *   - 批量: saveAs:false 静默到 Downloads/课程名/ 子文件夹
 */
async function batchDownloadV10(ppts: PPTResource[]): Promise<void> {
  const folderName = extractCourseFolderName();
  log(`[V10-BATCH] 课程文件夹名: ${folderName}`);
  showUserMessage(`📦 开始批量下载 ${ppts.length} 个文件到 "${folderName}/"...`);

  // 第一步：逐个fetch status API获取CDN直链
  const files: Array<{cdnUrl: string, filename: string}> = [];
  
  for (let i = 0; i < ppts.length; i++) {
    const ppt = ppts[i];
    log(`[V10-BATCH] (${i + 1}/${ppts.length}) 获取直链接: ${ppt.title}`);

    try {
      const meta = ppt.meta || {};
      const candidateUrls = buildCandidateUrls(meta);
      let gotUrl = false;

      for (const urlInfo of candidateUrls) {
        if (urlInfo.method === 'status_fetch') {
          const result = await fetchStatusAndGetDownloadUrl(urlInfo.url);
          if (result) {
            const ext = result.isPdf ? 'pdf' : (ppt.type === 'pptx' ? 'pptx' : 'ppt');
            const filename = `${ppt.title}.${ext}`;
            files.push({ cdnUrl: result.url, filename });
            log(`[V10-BATCH] ✅ ${filename}: 直链就绪`);
            gotUrl = true;
            break;
          }
        }
      }

      if (!gotUrl) {
        log(`[V10-BATCH] ⚠️ ${ppt.title}: 无法获取直链接，跳过`);
        // 可以在这里fallback到单个V9.4方式，暂时跳过
      }
    } catch (e) {
      logErr(`[V10-BATCH] ⚠️ ${ppt.title}: ${(e as Error).message}`);
    }

    // status API请求间隔200ms，避免被限速
    if (i < ppts.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (files.length === 0) {
    showUserMessage('❌ 所有文件都无法获取下载链接');
    return;
  }

  log(`[V10-BATCH] 成功获取 ${files.length}/${ppts.length} 个直链接，发送给Background...`);
  showUserMessage(`⏳ 正在下载 ${files.length} 个文件到 "${folderName}/"，请稍候...`);

  // 第二步：一次性发给Background批量处理
  const batchResult = await new Promise<BatchV10Response>((resolve) => {
    chrome.runtime.sendMessage({
      type: 'BATCH_DOWNLOAD_V10',
      files,
      folderName
    }, (response: BatchV10Response) => {
      resolve(response || { success: false, error: '无响应（可能SW超时）' });
    });

    // 批量下载可能需要较长时间（每个文件都要fetch），给5分钟超时
    setTimeout(() => {
      resolve({ success: false, error: '批量下载超时(5min)' });
    }, 300000);
  });

  // 第三步：汇报结果
  if (batchResult.success) {
    const s = batchResult.successCount || 0;
    const f = batchResult.failCount || 0;
    
    // 标记所有成功项为已下载
    files.forEach(file => {
      const ppt = ppts.find(p => file.filename.includes(p.title));
      if (ppt) {
        ppt.downloaded = true;
        updateSingleItemStatus(ppt, true);
      }
    });

    showUserMessage(`✅ 批量下载完成: ${s}成功 ${f}失败 → Downloads/${sanitizeFolderName(folderName)}/`);
    log(`[V10-BATCH] ✅ 完成: ${s}成功, ${f}失败`);
  } else {
    showUserMessage(`❌ 批量下载失败: ${batchResult.error || '未知错误'}`);
    logErr(`[V10-BATCH] 失败: ${batchResult.error}`);
  }
}

/** 简单的文件名清理（与BG端保持一致） */
function sanitizeFolderName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.')
    .trim() || 'ChaoXing_Download';
}

/**
 * 将PPT加入批量下载队列并开始处理（兼容旧逻辑入口）
 * - 单个文件走 V10 saveAs:true（弹对话框）
 * - 多个文件走 BATCH_DOWNLOAD_V10（静默到子文件夹）
 */
async function enqueueBatchDownload(ppts: PPTResource[]): Promise<void> {
  if (isDownloading) {
    showUserMessage('正在下载中，请等待当前批次完成');
    return;
  }

  const pendingPpts = ppts.filter(p => !p.downloaded);
  if (pendingPpts.length === 0) {
    showUserMessage('没有待下载的PPT');
    return;
  }

  isDownloading = true;

  if (pendingPpts.length === 1) {
    // 单个文件：走原来的V10流程（弹对话框让用户选位置）
    try {
      await downloadPPTFromContent(pendingPpts[0]);
      pendingPpts[0].downloaded = true;
      updateSingleItemStatus(pendingPpts[0], true);
    } catch (e) {
      logErr(`单个下载失败: ${(e as Error).message}`);
    }
  } else {
    // 多个文件：走新的批量V10流程（静默到子文件夹）
    await batchDownloadV10(pendingPpts);
  }

  isDownloading = false;
}

/** 更新单个PPT项在列表中的状态显示 */
function updateSingleItemStatus(ppt: PPTResource, downloaded: boolean): void {
  const idx = detectedPPTs.findIndex(p => p.id === ppt.id);
  if (idx >= 0) {
    const btn = document.querySelector(`button.download-single-btn[data-index="${idx}"]`) as HTMLButtonElement;
    if (btn) {
      btn.textContent = downloaded ? '已下载' : '下载';
      btn.disabled = downloaded;
    }
  }
}

/** 用隐藏iframe加载URL并提取其中的图片 */
function showUserMessage(msg: string): void {
  // 移除旧的
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

/** 调用页面原生的toOpen()函数 */
function invokeOriginalToOpen(ppt: PPTResource): void {
  const meta = ppt.meta || {};
  // 尝试找到页面上的toOpen函数并调用
  const win = window as any;
  if (typeof win.toOpen === 'function') {
    const { dataName, dataType, dataId, objectId, classId, enc, t } = meta;
    win.toOpen(
      dataName || ppt.title,
      dataType || ppt.type,
      dataId || '',
      '',
      objectId || '',
      '',
      '', // flag
      '', // source
      classId || '',
      enc || '',
      '',
      t || ''
    );
    log(`[invokeToOpen] 已调用`);
  } else {
    // toOpen不存在，直接打开一个新窗口提示用户
    log(`[invokeToOpen] toOpen不存在，打开空窗口`);
    window.open('about:blank', '_blank');
  }
}

/** 扫描资料区iframe的 li.dataBody_file */
function scanDataBodyFiles(iframeDoc: Document, iframeName: string): PPTResource[] {
  const ppts: PPTResource[] = [];
  const fileElements = iframeDoc.querySelectorAll('li.dataBody_file');
  
  log(`[${iframeName}] 扫描 li.dataBody_file: 匹配 ${fileElements.length} 个元素`);
  
  fileElements.forEach((li, index) => {
    const onclickAttr = li.getAttribute('onclick') || '';
    
    if (!onclickAttr) {
      log(`  [${iframeName}] 文件${index + 1}: 无onclick属性`);
      return;
    }
    
    const params = parseToOpenParams(onclickAttr);
    
    if (!params) {
      log(`  [${iframeName}] 文件${index + 1}: 无法解析toOpen参数`);
      return;
    }
    
    if (params.dataType !== 'ppt' && params.dataType !== 'pptx') {
      return;
    }
    
    log(`  [${iframeName}] ${index + 1}. [${params.dataType}] ${params.dataName}`);
    log(`    objectId=${params.objectId}, dataId=${params.dataId}`);
    
    // 构建API URL（用objectId）
    const downloadApi = `https://mooc1.chaoxing.com/ananas/status/${params.objectId}?flag=normal`;
    
    ppts.push({
      id: `data_${params.objectId}_${index}`,
      title: params.dataName.replace(/\.(ppt|pptx)$/i, ''),
      url: downloadApi, // URL是API地址，下载时再请求
      type: params.dataType as 'ppt' | 'pptx',
      chapterId: undefined,
      courseId: params.classId,
      downloaded: false,
      // 附加资料区特有字段
      meta: {
        dataId: params.dataId,
        objectId: params.objectId,
        classId: params.classId,
        enc: params.enc,
        t: params.t
      }
    });
  });
  
  return ppts;
}

/** 在单个 document 内扫描传统PPT链接 */
function scanDocumentForPPTs(doc: Document, frameLabel = '主页面'): PPTResource[] {
  const ppts: PPTResource[] = [];
  
  const selector = 'a[href*=".ppt"], a[href*=".pptx"], [href*=".ppt"], [href*=".pptx"]';
  const elements = doc.querySelectorAll(selector);
  
  log(`[${frameLabel}] DOM扫描(a标签): 匹配 ${elements.length} 个元素`);

  elements.forEach((element, index) => {
    const href = (element as HTMLAnchorElement).href || element.getAttribute('href') || '';
    if (!href.includes('.ppt') && !href.includes('.pptx')) return;
    
    const title = element.textContent?.trim() || `PPT_${index + 1}`;
    const isPptx = href.includes('.pptx');
    
    ppts.push({
      id: `dom_ppt_${Date.now()}_${index}`,
      title: title.replace(/\.(ppt|pptx)$/i, ''),
      url: href,
      type: isPptx ? 'pptx' : 'ppt',
      downloaded: false
    });
  });

  return ppts;
}

/** 扫描当前窗口及所有同域子iframe */
async function detectPPTResources(): Promise<PPTResource[]> {
  log('========== 开始扫描PPT ==========');
  log(`当前URL: ${window.location.href}`);
  
  const ppts: PPTResource[] = [];

  // 1. 扫描主页面DOM（传统a标签）
  ppts.push(...scanDocumentForPPTs(document, '主页'));

  // 2. 扫描资料区iframe (#frame_content-zl) - 核心扫描方式
  const zlIframe = document.querySelector<HTMLIFrameElement>('#frame_content-zl');
  if (zlIframe) {
    try {
      const iframeDoc = zlIframe.contentWindow?.document;
      if (iframeDoc) {
        log('[资料区] 发现 iframe #frame_content-zl，开始扫描...');
        ppts.push(...scanDataBodyFiles(iframeDoc, '资料区'));
        
        // 也扫描iframe内的传统a标签
        ppts.push(...scanDocumentForPPTs(iframeDoc, '资料区-链接'));
      } else {
        log('[资料区] iframeDoc 为空');
      }
    } catch (e) {
      logErr('[资料区] 跨域不可访问:', e);
    }
  } else {
    log('[资料区] 未发现 iframe #frame_content-zl');
  }

  // 3. 扫描其他iframe（课程区域）
  const otherIframes = document.querySelectorAll<HTMLIFrameElement>('iframe:not(#frame_content-zl)');
  otherIframes.forEach((iframe, idx) => {
    try {
      const iframeDoc = iframe.contentWindow?.document;
      if (iframeDoc) {
        const name = iframe.name || iframe.id || `iframe_${idx}`;
        ppts.push(...scanDataBodyFiles(iframeDoc, name));
        ppts.push(...scanDocumentForPPTs(iframeDoc, name));
      }
    } catch (_e) {
      // 跨域跳过
    }
  });

  // 4. API层获取（课程区域传统方式）
  try {
    log('[API] 调用 fetchPPTFromAPI...');
    const apiPpts = await fetchPPTFromAPI();
    log(`[API] 获取到 ${apiPpts.length} 个PPT`);
    ppts.push(...apiPpts);
  } catch (e) {
    logErr('[API] 获取失败:', e);
  }

  // 去重
  const uniquePpts = [...new Map(ppts.map(ppt => [ppt.url, ppt])).values()];
  log(`========== 扫描完成: 共 ${uniquePpts.length} 个唯一PPT ==========`);
  if (uniquePpts.length > 0) {
    uniquePpts.forEach((ppt, i) => log(`  ${i + 1}. [${ppt.type}] ${ppt.title}`));
  }
  return uniquePpts;
}

async function fetchPPTFromAPI(): Promise<PPTResource[]> {
  const urlParams = new URLSearchParams(window.location.search);
  const courseId = urlParams.get('courseId') || urlParams.get('courseid') || null;
  const chapterId = urlParams.get('chapterId') || null;
  
  if (!courseId) {
    log('[API] courseId为空，跳过API调用');
    return [];
  }

  const apiUrl = `https://mooc1.chaoxing.com/ananas/status/${courseId}?flag=normal`;
  log(`[API] 请求: ${apiUrl}`);

  try {
    const response = await fetch(apiUrl, {
      credentials: 'include',
      headers: { 'Accept': 'application/json' }
    });

    log(`[API] 响应: status=${response.status}`);
    if (!response.ok) return [];

    const data = await response.json();
    
    if (data?.data?.objectList) {
      return data.data.objectList
        .filter((item: any) => 
          item?.objectType === 'ppt' || 
          item?.property?.ext?.match(/\.(ppt|pptx)$/i)
        )
        .map((item: any, index: number) => ({
          id: `api_ppt_${Date.now()}_${index}`,
          title: item.property?.title || `API_PPT_${index + 1}`,
          url: item.durl || item.objectUrl || '',
          type: (item.property?.ext || '').includes('pptx') ? 'pptx' : 'ppt',
          chapterId: chapterId || undefined,
          courseId,
          downloaded: false
        }));
    }
  } catch (e) {
    logErr('[API] 请求错误:', e);
  }

  return [];
}

// ===== UI注入与销毁 =====

const CONTAINER_ID = 'chaoxing-ppt-downloader-container';
let lastUrl = window.location.href;
let injected = false;
let observer: MutationObserver | null = null;

function destroyExistingUI(): void {
  const existing = document.getElementById(CONTAINER_ID);
  if (existing) {
    existing.remove();
    log('销毁已有UI');
  }
  injected = false;
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

let detectedPPTs: PPTResource[] = [];

function displayPPTList(ppts: PPTResource[]): void {
  detectedPPTs = ppts;
  const container = document.getElementById('ppt-list-container');
  if (!container) return;

  container.style.display = 'block';
  container.innerHTML = `
    <h4>📊 检测到 ${ppts.length} 个PPT</h4>
    ${ppts.map((ppt, index) => `
      <div class="ppt-item" data-index="${index}">
        <span class="ppt-type">${ppt.type.toUpperCase()}</span>
        <span class="ppt-title">${index + 1}. ${ppt.title}</span>
        <button class="download-single-btn" data-index="${index}">下载</button>
      </div>
    `).join('')}
  `;

  container.querySelectorAll('.download-single-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = e.target as HTMLButtonElement;
      const idx = parseInt(target.dataset.index || '0');
      const ppt = detectedPPTs[idx];
      if (ppt) {
        log(`下载单个: ${ppt.title}`);
        target.textContent = '下载中...';
        target.disabled = true;
        try {
          await downloadPPTFromContent(ppt);
          ppt.downloaded = true;
          target.textContent = '已下载';
          log(`✅ ${ppt.title} 下载成功`);
        } catch (err) {
          target.textContent = '下载';
          target.disabled = false;
          logErr(`❌ ${ppt.title} 下载失败:`, err);
        }
      }
    });
  });
}

function setupButtonHandlers(): void {
  // 关闭按钮
  document.getElementById('ppt-close-btn')?.addEventListener('click', () => {
    destroyExistingUI();
  });

  // 扫描按钮
  document.getElementById('scan-ppt-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('scan-ppt-btn') as HTMLButtonElement;
    log('点击扫描按钮');
    btn.textContent = '扫描中...';
    btn.disabled = true;

    try {
      const ppts = await detectPPTResources();
      
      if (ppts.length > 0) {
        log(`扫描成功，发现 ${ppts.length} 个PPT`);
        displayPPTList(ppts);
        const dlBtn = document.getElementById('download-all-btn');
        if (dlBtn) {
          dlBtn.style.display = 'inline-block';
          dlBtn.textContent = `批量下载 (${ppts.length})`;
        }
        btn.textContent = `已发现 ${ppts.length} 个`;
        chrome.runtime.sendMessage({ type: 'PPT_LIST_RESULT', ppts });
      } else {
        warn('扫描完成，未发现PPT资源');
        btn.textContent = '未发现PPT';
        setTimeout(() => {
          btn.textContent = '扫描PPT';
          btn.disabled = false;
        }, 2000);
      }
    } catch (e) {
      logErr('扫描异常:', e);
      btn.textContent = '扫描出错';
      setTimeout(() => {
        btn.textContent = '扫描PPT';
        btn.disabled = false;
      }, 2000);
    }
  });

  // 批量下载按钮 — 使用队列机制
  document.getElementById('download-all-btn')?.addEventListener('click', async () => {
    await enqueueBatchDownload(detectedPPTs);
  });
}

function injectDownloadButton(): void {
  // 只在顶层窗口注入
  if (window !== window.top) return;
  // 只在学习通页面注入
  if (!isChaoxingHostname()) return;
  // 已存在则跳过
  if (injected && document.getElementById(CONTAINER_ID)) return;

  log(`注入UI`);
  destroyExistingUI();

  const container = createContainerUI();
  document.body.appendChild(container);
  injected = true;
  
  // 设置事件监听
  setupButtonHandlers();
}

// ===== 初始化（只在顶层）=====
if (window === window.top && isChaoxingHostname()) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectDownloadButton);
  } else {
    injectDownloadButton();
  }

  // SPA路由切换检测：只监听 body 的直接子元素
  observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      log(`URL变更: ${lastUrl.substring(0, 60)}...`);
      lastUrl = window.location.href;
      destroyExistingUI();
      setTimeout(injectDownloadButton, 500);
    }
  });
  observer.observe(document.body, { childList: true });
}

// 消息监听
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PPT_LIST') {
    detectPPTResources().then(ppts => sendResponse({ ppts }));
    return true;
  }
});
