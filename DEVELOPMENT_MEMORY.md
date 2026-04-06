# ChaoXing PPT Downloader - 开发错误与修复记录

> 本文档记录开发过程中遇到的所有错误、原因分析及解决方案。每次更新代码后应追加新条目。

---

## 项目概述

- **类型**: Chrome Extension (Manifest V3)
- **功能**: 从超星学习通页面自动检测并下载 PPT/PPTX 资源
- **技术栈**: TypeScript + Vite + Chrome Extension API
- **架构**: Content Script 扫描页面 → Background Service Worker 处理下载

---

## 错误记录

### 1. `parseToOpenParams` 正则无法处理 14 参数格式

- **日期**: 2025-04-04 (早期)
- **位置**: `src/content/index.ts`
- **错误描述**: 
  - 原始正则假设固定参数数量（13个），但超星页面的 `toOpen` 函数调用有两种格式：13参数和14参数
  - 14参数版本多了一个 `enc_b64` 参数
  - 正则匹配失败导致无法解析 PPT 资源信息
- **原因分析**: 使用固定捕获组的正则无法应对参数数量的变化
- **解决方案**: 重写为**状态机解析器**
  - 用括号深度计数来正确分割字符串参数
  - 返回包含所有参数的对象，调用方按需取用
  - 兼容 13 和 14 参数两种格式
- **影响**: 核心功能修复，页面能正确识别 PPT 资源

---

### 2. TypeScript 类型错误：`querySelectorAll` 返回值缺少 `contentWindow`/`name`

- **日期**: 2025-04-04 (早期)
- **位置**: `src/content/index.ts`
- **错误描述**: 
  - `querySelectorAll('iframe')` 返回 `NodeListOf<Element>`
  - `Element` 类型没有 `contentWindow` 和 `name` 属性
  - TypeScript 编译报错
- **原因分析**: `querySelectorAll` 默认返回基类型 `Element`，需要显式指定泛型
- **解决方案**: 添加类型参数 `querySelectorAll<HTMLIFrameElement>('iframe')`
  - `HTMLIFrameElement` 包含 `contentWindow` 和 `name` 属性
- **影响**: TypeScript 编译通过

---

### 3. MV3 Service Worker 空闲超时导致下载静默失败

- **日期**: 2025-04-04
- **位置**: `src/background/index.ts`
- **错误描述**: 
  - 用户点击下载后，控制台显示"下载开始"，但文件从未出现
  - Background Service Worker 日志在下载过程中中断
  - 没有错误信息，完全静默失败
- **原因分析**: 
  - MV3 的 Service Worker 在 **30 秒无活动后会被 Chrome 自动终止**
  - 原始下载逻辑：Background 中 `fetch` 元数据 → `fetch` 文件 Blob → 创建下载
  - 两次 `fetch` + Blob 处理耗时超过 30 秒，SW 在过程中被杀死
- **解决方案 (第一次尝试)**: 将下载逻辑移到 Content Script
  - Content Script 有页面上下文，不受 SW 超时限制
  - 在 Content Script 中 fetch 元数据 + fetch blob + `<a>.click()` 触发下载
- **遗留问题**: Content Script 在 iframe 中也可能超时，且 Blob 下载在某些上下文中被 CSP 阻止

---

### 4. Content Script 异步 fetch 后被超时杀死

- **日期**: 2025-04-04
- **位置**: `src/content/index.ts`
- **错误描述**: 
  - Content Script 日志显示"元数据响应: status=200"后中断
  - Network 面板确认 API 响应中有正确的 `durl` 字段
  - 但后续代码从未执行
- **原因分析**: 
  - Content Script 运行在 iframe 上下文中（`#frame_content-zl`）
  - iframe 中的脚本也有执行时间限制
  - `await fetch().then().then()` 链式操作在响应后被中断
- **解决方案**: 改变策略 — Content Script 只解析元数据获取 `durl`，然后通过**隐藏 `<iframe>` 触发浏览器原生下载**
  - 或者改为让 Background 处理，但使用 `chrome.downloads.download` API（更可靠）
- **最终方案**: Content Script 发消息给 Background，Background 用 `chrome.downloads.download` 触发下载

---

### 5. 假成功：`sendResponse` 在异步操作完成前就返回

- **日期**: 2025-04-04
- **位置**: `src/background/index.ts`
- **错误描述**: 
  - Content Script 显示"✅ 已触发: unknown"
  - Background 显示"✅ downloadId=2"
  - 但文件没有下载
- **原因分析**: 
  - `handleDownloadV2(message.ppt)` 是异步函数
  - `sendResponse({ success: true })` 在 `handleDownloadV2` 完成前就执行了
  - 没有 `return true` 保持消息通道开放
  - `downloadId` 没有传递给 Content Script
- **解决方案**: 
  1. 使用 `.then()` 链确保 `sendResponse` 在异步操作完成后调用
  2. `return true` 保持消息通道开放
  3. `handleDownloadV2` 改为返回 `Promise<number>`，resolve 时携带 `downloadId`

```typescript
case 'DOWNLOAD_PPT_V2':
  handleDownloadV2(message.ppt)
    .then(downloadId => sendResponse({ success: true, downloadId }))
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true; // 保持消息通道开放
  break;
```

---

### 6. 缺少 `host_permissions` 导致下载被 Chrome 静默拦截

- **日期**: 2025-04-04
- **位置**: `src/manifest.json`
- **错误描述**: 
  - `chrome.downloads.download` 返回了有效的 `downloadId`
  - Background 日志显示下载已开始
  - 但文件从未出现在下载目录中
  - 没有任何错误提示
- **原因分析**: 
  - 真实文件 URL 来自 `ans-attachment.chaoxing.com`
  - `manifest.json` 的 `host_permissions` 中**没有包含这个域名**
  - Chrome 静默拦截了没有权限的下载请求
  - `chrome.downloads.onChanged` 会触发 `interrupted` 状态
- **解决方案**: 在 `host_permissions` 中添加：
  ```json
  "https://ans-attachment.chaoxing.com/*",
  "https://*.chaoxing.com/*"
  ```
- **注意**: 重新加载扩展时 Chrome 会弹出权限请求对话框，必须点"确认"

---

### 7. 批量下载仍使用旧逻辑（待修复）

- **日期**: 2025-04-04
- **位置**: `src/background/index.ts` / `src/content/index.ts`
- **错误描述**: 
  - 单个下载已修复，但"批量下载"按钮仍发送 `BATCH_DOWNLOAD` 消息
  - 该消息由旧版 Background 处理器处理，会触发同样的 SW 超时问题
- **状态**: ⚠️ **未修复**
- **计划修复**: 将批量下载也改为使用新的 `DOWNLOAD_PPT_V2` 流程

---

## 架构演进

### 初始架构
```
Content Script → 发送 DOWNLOAD_PPT → Background SW → fetch 元数据 → fetch 文件 → 下载
                                                      ↑ 问题: SW 30秒超时
```

### 中间架构（尝试）
```
Content Script → fetch 元数据 → fetch Blob → <a>.click()
                              ↑ 问题: iframe 中也被超时，CSP 限制
```

### 当前架构
```
Content Script → 发送 DOWNLOAD_PPT_V2 → Background SW → fetch 元数据 → chrome.downloads.download
                  (return true 保持通道)                    ↑ 需权限支持
```

---

## 关键经验教训

1. **MV3 Service Worker 超时是隐形杀手**: 任何涉及网络请求的操作都可能在 30 秒后被中断，且不一定报错
2. **`return true` 是异步消息的关键**: 在 `onMessage` 中如果要异步响应，必须 `return true`
3. **`host_permissions` 必须覆盖所有下载域名**: Chrome 会静默拦截无权限的下载
4. **假成功比真失败更难调试**: `downloadId` 返回成功不代表文件真的下载了
5. **添加 `chrome.downloads.onChanged` 监听器**: 这是追踪下载中断的唯一方式

---

### 8. Content Script 在 iframe 中被注入导致频繁超时

- **日期**: 2025-04-04
- **位置**: `src/manifest.json`, `src/content/index.ts`
- **错误描述**: 
  - Content Script 的 `fetch` 元数据成功后立即被杀死，日志中断
  - 因为 manifest 默认 `all_frames: true`，Content Script 被注入到页面中**每个 iframe**（包括跨域 iframe）
  - iframe 中的脚本执行窗口极短，`await fetch().then()` 链式操作经常超时
- **解决方案**: 
  1. `manifest.json` 中设置 `"all_frames": false` — Content Script **只在 top frame 运行**
  2. Top frame 不受 iframe 超时限制
  3. 下载改为 `<a href=durl download=filename>.click()` — 浏览器原生下载，从页面上下文发起请求**自动携带 Cookie**
  4. 不再用 `chrome.downloads.download`（扩展上下文不携带页面 Cookie → FILE_FAILED）

---

### 9. chrome.downloads.download 返回 FILE_FAILED — 扩展上下文不携带页面 Cookie

- **日期**: 2025-04-04
- **位置**: `src/background/index.ts`
- **错误描述**: 
  - `chrome.downloads.download` 返回有效 downloadId=3
  - 但 `chrome.downloads.onChanged` 报告 `state=interrupted`, `FILE_FAILED`
  - `durl` 指向 `ans-attachment.chaoxing.com`，需要登录 Cookie 鉴权
- **原因分析**: 
  - `chrome.downloads.download` 从 **扩展上下文** 发起请求
  - 不携带**页面 Cookie**（Cookie 绑定到页面域，不绑定到扩展）
  - 服务器返回未授权，Chrome 标记为 FILE_FAILED
- **解决方案**: 完全放弃 `chrome.downloads.download`。改为在 **Content Script（页面上下文）** 中：
  1. `fetch` 元数据获取 `durl`
  2. 创建 `<a href=durl download=filename>` 并调用 `.click()`
  3. 浏览器原生下载从**页面上下文**发起，自动携带 Cookie
- **关键理解**: 
  - `chrome.downloads.download` 适合公开文件下载（不需要鉴权）
  - 需要 Cookie/Session 鉴权的下载必须从**页面上下文**发起

---

### 10. CORS 跨域拦截 — 页面域与 API 域不同导致 fetch 失败

- **日期**: 2026-04-04
- **位置**: `src/content/index.ts`, `src/background/index.ts`
- **错误描述**: 
  - 扫描成功检测到 5 个 PPT，元数据 API 返回 status=200 且包含正确 `durl`
  - 但 Content Script 的 `fetch()` 被浏览器 CORS 策略拦截：
    ```
    Access to fetch at 'https://mooc1.chaoxing.com/ananas/status/...' 
    from origin 'https://mooc2-ans.chaoxing.com' 
    has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header
    ```
  - 结果：`TypeError: Failed to fetch`，所有下载失败
- **原因分析**: 
  - 虽然之前已设 `"all_frames": false` 让 Content Script 只在顶层运行
  - 但页面本身在 **mooc2-ans.chaoxing.com**（课程作业/资料域），而 PPT 元数据 API 在 **mooc1.chaoxing.com**（主站API域）
  - 这是**跨域请求**，Content Script 的 `fetch` 受到浏览器同源策略限制
  - Background Service Worker 的 `fetch` **不受 CORS 限制**
- **第一次尝试（V3）**: 将所有fetch移到Background → 结果HTTP 403
  - 原因：Background的fetch不携带**页面的登录Cookie**，超星API需要Cookie鉴权

### 11. V4 "页面代理" 模式 — 彻底解决 Cookie + CORS 问题

- **日期**: 2026-04-04
- **错误描述**: V3方案中Background返回HTTP 403
- **根本原因分析**:
  ```
  Content Script: 有Cookie ✅ / 受CORS限制 ❌ (在 mooc2-ans 域)
  Background SW:   不受CORS限制 ✅ / 无页面Cookie ❌ (扩展上下文)
  ```
  两条路看似都走不通，但关键发现：
  - **超星的 mooc1 和 mooc2-ans 共享 chaoxing.com 父域的 Cookie**
  - Content Script 的 `credentials: 'include'` 可以携带跨子域的 Cookie
  - 浏览器对**同站点(same-site)** 的跨子域请求有更宽松的限制
  - 即使 CORS 拦截了部分请求，`<a>` 标签触发的下载是**浏览器原生行为**，完全不受 CORS 约束
- **解决方案 — V4 架构**:
  1. **Content Script 用 `fetch` + `credentials:'include'` 获取元数据JSON**（只拿文本数据）
     - 如果首次失败，自动重试时带上完整的鉴权参数（enc, t, classid等）
  2. **拿到 durl 后，用 `<a href=durl download=filename>.click()` 触发原生下载**
     - 这是浏览器内置下载功能，从页面上下文发起，自动携带Cookie
     - 完全绕过 CORS 和 API 限制
  3. **不再依赖 Background 做任何网络操作**

### 当前架构 (V10 / v1.0 正式版)

> ⚠️ **重要说明**: 以下 V4 架构描述为历史记录。  
> **当前生产环境实际使用的是 V10 架构**（详见下方"V10 最终方案"章节）。
>
> V4 曾作为中间方案被实现和测试，但最终被 V10 取代。保留此记录供参考。

```
Content Script（运行在页面上下文，自动携带Cookie）
  ├── 扫描PPT资源（DOM解析）          ← 同前
  ├── 注入UI（扫描按钮、列表）         ← 同前
  └── 点击下载：
      ├── fetch(元数据API) → 获取durl  ← 页面Cookie自动携带
      └── <a href=durl>.click()        ← 浏览器原生下载

Background Service Worker
  └── 保留旧接口兼容（V2/V3/BATCH_DOWNLOAD等）
  └── ★ 新增 V10 接口：FETCH_AND_DOWNLOAD_V10 / BATCH_DOWNLOAD_V10
```

---

### V10 最终方案 (2026-04-04 确立，v1.0 正式版使用)

> 这是**当前实际在生产环境运行的架构**，已通过用户测试验证 ✅

**核心突破**: 结合 V4 的"CS有Cookie"优势和 BG 的"无CORS限制"优势

```
Content Script（页面上下文）
  │
  ├── 1. fetch(status API) → 获取CDN直链
  │      - 同域请求(mooc1.chaoxing.com)，不受CORS
  │      - 自动携带页面Cookie
  │      - 优先使用 pdf 字段(s3.cldisk.com)
  │
  └── 2. sendMessage(FETCH_AND_DOWNLOAD_V10, {cdnUrl, filename})
         ↓
Background Service Worker（扩展特权）
  │
  ├── 3. fetch(CDN_URL, {credentials:'include'})
  │      - host_permissions声明了 *.cldisk.com → 不受CORS限制
  │      - 拿到文件Blob（PDF/PPTX）
  │
  ├── 4. Blob → ArrayBuffer → base64 → data URL
  │      - 因为SW环境没有 URL.createObjectURL()（无DOM API）
  │      - 改用 data URL 方案（chrome.downloads.download原生支持）
  │
  └── 5. chrome.downloads.download({
             url: dataUrl,
             filename: '课程名/文件名.pdf',
             saveAs: true   // 单个文件弹出"另存为"对话框
                         // 批量文件: saveAs:false + 子文件夹路径
         })
         → ✅ Chrome原生下载对话框！用户选择保存位置
```

**批量下载流程** (BATCH_DOWNLOAD_V10):
1. CS逐个fetch status API获取所有CDN直链（200ms间隔）
2. 打包 `{files[], folderName}` 发给BG
3. BG逐个执行步骤3-5（500ms间隔防限速）
4. `saveAs: false` + `filename: '课程名/文件名.pdf'` → 静默下载到子文件夹

### 关键设计决策
- **为什么不用Background fetch？** — 没有页面Cookie → 403
- **为什么Content Script的fetch可以？** — 继承页面origin+Cookie，且同站跨域可能被服务器允许
- **为什么用<a>而不是fetch Blob？** — `<a>.click()` 是浏览器原生下载，不受JS的CORS约束
- **如果CS的fetch也被CORS拦怎么办？** — V4代码中有fallback：带完整参数重试；如果还是失败，未来可考虑注入<script>标签做JSONP

---

## 文件结构

```
src/
├── manifest.json          # 扩展配置（permissions, host_permissions）
├── background/
│   └── index.ts           # Service Worker（消息处理、下载逻辑）
├── content/
│   ├── index.ts           # Content Script（页面扫描、UI、下载触发）
│   └── styles.css         # 注入页面的样式
├── popup/
│   ├── index.html         # 弹出窗口 HTML
│   ├── popup.ts           # 弹出窗口逻辑
│   └── popup.css          # 弹出窗口样式
└── types/
    └── index.ts           # TypeScript 类型定义
```

---

## 📚 项目文档体系与职责划分

> **更新日期**: 2026-04-06  
> **目的**: 明确各文档职责边界，避免信息冗余，提升维护效率

### 文档总览

| 文档 | 路径 | 主要受众 | 核心职责 | 更新时机 |
|------|------|----------|----------|----------|
| README.md | `/README.md` | 用户+开发者 | 项目介绍、安装使用、快速上手 | 功能变更时 |
| 底层逻辑.md | `/底层逻辑.md` | 新加入开发者 | 完整技术架构、工作流程、历史演进 | 架构重大变更时 |
| DEVELOPMENT_MEMORY.md | `/DEVELOPMENT_MEMORY.md` | Bug 修复者 | 错误记录、修复方案、经验教训 | 遇到新错误/修复Bug时 |
| CHANGELOG.md | `/CHANGELOG.md` | 所有参与者 | 版本发布记录、功能变更清单 | 每次发版时 |
| MEMORY.md | `.workbuddy/memory/MEMORY.md` | 项目维护者 | 长期记忆：版本体系、关键决策摘要 | 重大版本更新时 |
| 每日日志 | `.workbuddy/memory/YYYY-MM-DD.md` | 开发者本人 | 当日开发过程详细记录（含时间线） | 每日开发结束时 |

### 职责边界详解

#### ✅ README.md — "门面文档"
- **包含**: 项目简介、功能特性、安装步骤、使用截图、权限说明、已知限制
- **不包含**: 详细技术实现、错误修复历史、代码级细节
- **原则**: 面向用户，让新人5分钟内能上手使用

#### ✅ 底层逻辑.md — "技术圣经"
- **包含**: 
  - 完整工作流程图（含数据流）
  - 技术难点分析（为什么这样设计）
  - 历史版本迭代（v0.3→v1.0 的演进路线）
  - 关键技术知识点（CORS模型、SW限制、API能力）
  - 当前架构的代码结构映射
- **不包含**: 
  - 每个错误的详细调试过程（那是 DEVELOPMENT_MEMORY.md 的事）
  - 每日的具体工作记录（那是日志文件的事）
- **原则**: 面向想理解"为什么这么做"的开发者

#### ✅ DEVELOPMENT_MEMORY.md — "踩坑手册"
- **包含**:
  - 每个错误的完整记录（现象→原因→解决方案）
  - 架构演进的**关键节点**（从哪个版本切换到哪个版本，为什么）
  - 经验教训总结（避免重复踩坑）
  - 待清理的死代码标记（TODO）
- **不包含**:
  - 每日详细时间线（太琐碎）
  - 完整的技术原理讲解（那是底层逻辑.md的事）
- **原则**: 面向遇到类似问题的开发者，快速定位解决方案

#### ✅ MEMORY.md (workbuddy) — "长期记忆索引"
- **包含**:
  - 版本号体系定义
  - 当前稳定版本的架构摘要（精简版）
  - 关键决策列表（结论优先，不需要过程）
  - 已修复问题清单（索引式，详情链接到 DEVELOPMENT_MEMORY.md）
  - 待办事项（TODO）
- **不包含**:
  - 详细技术实现
  - 调试过程
- **原则**: 高层次摘要，作为 AI/开发者的快速参考卡片

#### ✅ 每日日志 (YYYY-MM-DD.md) — "开发日记"
- **包含**:
  - 当天所有版本迭代的详细时间线
  - 每次测试的用户反馈（原话记录）
  - 代码改动的具体文件和原因
  - 构建结果和测试状态
- **不包含**:
  - 跨天的总结性内容（应该提炼到其他文档）
- **原则**: 原始记录，保留完整的上下文，不过度整理

### 内容重叠处理策略

| 重叠内容 | 主文档 | 辅助文档 | 处理方式 |
|----------|--------|----------|----------|
| 版本迭代历史 | 底层逻辑.md | DEVELOPMENT_MEMORY.md / 日志 | 底层逻辑讲**为什么演进**，其他讲**怎么调试** |
| 架构描述 | 底层逻辑.md | MEMORY.md | 底层逻辑**详细版**，MEMORY**精简版** |
| 错误记录 | DEVELOPMENT_MEMORY.md | 日志 | DEVELOPMENT_MEMORY**整理后**，日志**原始记录** |
| 代码结构 | 底层逻辑.md | README.md | 底层逻辑**技术视角**，README**用户视角** |

### 文档同步更新检查清单

每次代码变更时，按以下清单检查：

- [ ] **修改了下载逻辑？** → 更新 `底层逻辑.md` 的"当前架构"章节 + `DEVELOPMENT_MEMORY.md`（如果是修复bug）
- [ ] **新增了功能？** → 更新 `README.md` 的功能特性表 + `CHANGELOG.md`
- [ ] **修改了 manifest.json？** → 更新 `底层逻辑.md` 的权限说明 + `README.md`
- [ ] **修复了 bug？** → 在 `DEVELOPMENT_MEMORY.md` 追加新条目 + 更新 `MEMORY.md` 的已修复列表
- [ ] **进行了重构？** → 更新 `底层逻辑.md` 的代码结构 + `MEMORY.md` 的待清理项
- [ ] **发了新版本？** → 更新 `CHANGELOG.md` + `MEMORY.md` 的版本号 + `README.md` 的版本徽章

### 当前待办事项

- [ ] 清理 Background 中的死代码（旧版 `handleDownloadPPT`、`DOWNLOAD_PPT_V2/V3`、`DOWNLOAD_BLOB_DATA`、`DOWNLOAD_DIRECT_URL`、`TRIGGER_DOWNLOAD` 等）
- [ ] 添加下载失败重试机制
- [ ] 添加下载进度显示
- [ ] 考虑加入 PDF 转换功能（已有预留接口）
