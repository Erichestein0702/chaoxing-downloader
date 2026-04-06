# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)。

---

## [1.0.0] - 2026-04-04 🎉 正式发布

### ✅ 新增

- **Chrome 原生下载体验** — 点击下载后弹出"另存为"对话框，用户自由选择保存位置
- **自动 PPT 检测** — 扫描超星学习通"资料区"中的所有 PPT/PPTX 资源，解析 `toOpen()` onclick 参数提取元数据
- **单个文件下载** — 逐个点击下载按钮，每个文件独立触发保存对话框
- **批量下载（实验性）** — 一键下载所有检测到的文件到指定子文件夹（功能待完善）
- **智能 Fallback 机制** — 主路径失败时自动降级为备用方案，确保可用性

### 🔧 技术实现

- **核心方案**: Content Script 同域 fetch status API → Background Service Worker 跨域 fetch CDN → Data URL → `chrome.downloads.download({saveAs: true})`
- **Data URL 方案**: 解决了 Service Worker 环境中 `URL.createObjectURL()` 不可用的问题（Blob → ArrayBuffer → base64 → data URI）
- **host_permissions 声明**: `https://*.cldisk.com/*` 使 BG fetch 绕过 CORS 限制
- **状态机参数解析**: 可靠解析 `toOpen()` 的 13+ 参数 onclick 属性字符串
- **CDN 字段优先级**: `pdf`(s3.cldisk.com) > `download`(d0.cldisk.com) > `preview`

### 📁 文件变更

| 文件 | 变更说明 |
|------|---------|
| `src/manifest.json` | 新增 `*.cldisk.com` host_permissions |
| `src/background/index.ts` | 新增 V10/V10.1 下载消息处理、sanitizeFolderName() |
| `src/content/index.ts` | 重写下载主流程、新增批量逻辑、课程名提取 |

---

## [0.x] 内测版本历史（2026-04-03 ~ 2026-04-04）

> 以下记录从 v0.3 到 v0.11 的完整迭代过程。每一步都是对"如何绕过 CORS + Cookie 双重限制以下载文件"的探索。

### v0.3 — Background 全权处理
- **思路**: 所有网络操作在 BG 中执行
- **结果**: ❌ BG 无页面 Cookie → CDN 返回 HTTP 403

### v0.4 — Content Script fetch + `<a download>`
- **思路**: CS 有 Cookie，fetch 后用 `<a download>` 触发下载
- **结果**: ❌ `<a download>` 对跨域 URL 被浏览器静默忽略

### v0.5 — window.open(statusUrl)
- **思路**: 直接打开 status API URL 让浏览器处理
- **结果**: ❌ 浏览器展示原始 JSON 文本而非下载

### v0.6 — 隐藏 iframe 加载 status
- **思路**: iframe 加载后读取 contentDocument 解析
- **结果**: ❌ 跨域安全策略禁止读取 iframe 内容

### v0.7 — CS fetch status + `<a download>` CDN 直链
- **思路**: 分两步：CS 同域 fetch status 拿直链 → `<a download>` 指向 CDN
- **结果**: ❌ CDN 域名跨域，download 属性仍无效
- **发现**: 成功拿到 status JSON 中的 pdf/download/preview 字段！

### v0.7.1 — chrome.downloads.download(CDN 直链)
- **思路**: 拿到直链后直接传给 chrome.downloads.download()
- **结果**: ❌ "无法从网站提取文件" — BG 发起请求无有效鉴权信息

### v0.8 — CS fetch CDN → Blob → base64 → BG
- **思路**: 在 CS 中用 Cookie fetch CDN 拿 Blob，base64 编码后发给 BG
- **结果**: ❌ CS fetch CDN 本身被 CORS 拦截（Failed to fetch）

### v0.9 — 浏览器原生导航（突破口！）
- **核心认知**: CORS 只约束 JS fetch/XHR，不约束浏览器导航！
- **实现**: `window.location.assign(cdnUrl)` 或 `<a target="_blank">` + click()
- **结果**: ⚠️ 成功在新标签页打开 PDF，但以预览器形式内联显示，不是下载

#### 子版本迭代
| 版本 | 方法 | 问题 |
|------|------|------|
| v0.9.1 | 隐藏 `<iframe>` | CDN 403 防盗链 |
| v0.9.2 | `location.assign()` | 整页跳转离开原页面 |
| v0.9.3 | 优先使用 pdf 字段 | 还是内联显示 |
| v0.9.4 | `<a target="_blank">` + click() | ✅ 不离开页面，但仍非下载 |

### v0.10 / v0.11 — 最终方案 ✅
- **v0.10 思路**: BG 利用 host_permissions 绕过 CORS fetch CDN → Blob → createObjectURL → downloads
- **v0.10 结果**: ❌ `URL.createObjectURL is not a function` — SW 无 DOM API
- **v0.11 修复**: 改用 **Data URL** 替代 Blob URL
- **v0.11 结果**: ✅✅✅ **完美成功！用户确认所有 PDF 都能正常下载和打开！**

### v0.12 — 批量下载子文件夹（实验性）
- **新增**: BATCH_DOWNLOAD_V10 消息、saveAs:false 静默下载到 Downloads/课程名/
- **状态**: ⚠️ 存在 CORS 问题待修复（batchDownloadV10 中的 fetchPPTFromAPI 跨域）

---

## 版本号对照表

| 内测代号 | 旧代号 | 状态 | 说明 |
|---------|--------|------|------|
| v0.3~v0.8 | V3~V8 | ❌ 已废弃 | 各种 CORS/Cookie 尝试均失败 |
| v0.9~v0.9.4 | V9~V9.4 | ⚠️ 备用 fallback | 导航方案作为降级兜底保留 |
| v0.10 | V10 | ❌ 已废弃 | createObjectURL 在 SW 中不可用 |
| **v0.11** | **V10.1** | **✅ 稳定基础** | **Data URL 方案，单个下载完美运行** |
| v0.12 | V10.2 | ⚠️ 实验性 | 批量子文件夹功能待完善 |
| **v1.0** | — | **🎉 当前稳定版** | **基于 v0.11 正式发布** |

---

*最后更新: 2026-04-04*
