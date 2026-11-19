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

- [x] 清理 Background 中的死代码（旧版 `handleDownloadPPT`、`DOWNLOAD_PPT_V2/V3`、`DOWNLOAD_BLOB_DATA`、`DOWNLOAD_DIRECT_URL`、`TRIGGER_DOWNLOAD` 等）
- [x] 添加下载失败重试机制
- [x] 添加下载进度显示
- [x] 修复 v1.1.0 popup 下载按钮消息格式错位
- [x] 修复跨域 CORS(status API 从 content 移 background)
- [x] 修复 background fetch 403(同源代理 tab 方案)
- [x] 浮动面板内嵌日志面板(用户友好)
- [x] 主页面 404 检测
- [x] status API 404 优雅降级
- [ ] 考虑加入 PDF 转换功能（已有预留接口）
- [ ] 考虑用 chrome.cookies API 替代 mooc1 tab(更干净,但 cookies API 在 MV3 SW 中行为有差异)
- [ ] CDN fetch(background)目前用 `credentials: 'omit'`,如果 cldisk.com 也做 Origin 检查,需要类似 mooc1 tab 方案

---

## 2026-04-06 开发记录

### 12. 代码重构：清理 Background 死代码

- **日期**: 2026-04-06
- **位置**: `src/background/index.ts`
- **问题**: Background 存在大量历史遗留代码（V2/V3/V8 等废弃方案），影响可维护性
- **删除内容**:
  - 8 个废弃 handler: `V2`, `V3`, `DIRECT_URL`, `TRIGGER_DOWNLOAD`, `BLOB_DATA`, `BLOB_URL`, `DOWNLOAD_PPT`, `BATCH_DOWNLOAD`, `GET_STATUS`
  - 6 个废弃函数: `handleDownloadPPT()`, `handleDownloadV2()`, `handleDownloadV3()`, `handleBatchDownload()`, `ensureOriginalBlob()`, `notifyProgress()`, `showNotification()`
  - `downloadTasks` Map 和 `DownloadTask` 类型依赖
- **新增**: `blobToDataUrl()` 公共工具函数，V10Response/BatchV10Response 本地接口
- **统计**: `background/index.ts` 723行 → 235行 (**-67%**)
- **构建**: ✅ 通过

---

### 13. Content Script 模块化重构

- **日期**: 2026-04-06
- **位置**: `src/content/index.ts`
- **问题**: 1102 行代码逻辑混杂，难以维护
- **重构后结构**（按功能分区为 8 大模块）:
  1. 常量与类型定义 (CHAOXING_DOMAINS, SUPPORTED_TYPES, 接口定义)
  2. 日志系统 (log/warn/logErr)
  3. 工具函数 (isChaoxingHostname, sanitizeFolderName, showUserMessage)
  4. 参数解析器 (`parseToOpenParams()`)
  5. API请求层 (`buildCandidateUrls()`, `fetchStatusAndGetDownloadUrl()`)
  6. 下载引擎 (`sendToBackgroundV10()`, `navigateToDownload()`, `downloadPPTFromContent()`)
  7. 批量下载引擎 (`fetchStatusWithRetry()`, `batchDownloadV10()`, `enqueueBatchDownload()`)
  8. DOM扫描器 (`scanDataBodyFiles()`, `scanDocumentForLinks()`, `fetchPPTFromAPI()`, `detectPPTResources()`)
  9. UI层 (`createContainerUI()`, `displayPPTList()`, `setupButtonHandlers()`)
  10. 初始化 (事件监听, MutationObserver)
- **清理**: 删除废弃的 `extractImagesFromUrl()`, `downloadImages()`
- **优化**: `displayPPTList()` 改用 DOM 操作替代模板字符串（避免 XSS）
- **统计**: 1102行 → 740行 (**-33%**)
- **构建**: ✅ 通过

---

### 14. 批量下载 CORS 问题修复

- **日期**: 2026-04-06
- **位置**: `src/content/index.ts` - `buildCandidateUrls()`
- **问题**: `batchDownloadV10()` 中调用 `mooc2-ans.chaoxing.com` status API 跨域失败
- **根因**: 备用域 status API 与主站不同域，触发 CORS 拦截
- **修复**: 
  - 移除 `mooc2-ans.chaoxing.com` 备用 URL
  - 统一使用 `mooc1.chaoxing.com` 同域请求
  - 候选 URL 列表从 4 个减为 3 个（主站 status、预览、直接附件）
- **效果**: 批量下载不再因 CORS 失败

---

### 15. 下载进度实时显示

- **日期**: 2026-04-06
- **位置**: `src/content/index.ts`
- **新增**: `updateBatchProgress(current, total, msg)` 函数
- **UI 更新**: 
  - 批量下载按钮文字动态更新: `⏳ 3/10 获取 xxx 链接...`
  - Toast 消息同步显示当前进度
- **用户体验**: 用户知道下载进行到哪一步，不再焦虑等待

---

### 16. 失败重试机制

- **日期**: 2026-04-06
- **位置**: `src/content/index.ts`
- **新增**: `fetchStatusWithRetry(url, maxRetries=2)` 函数
- **策略**: 
  - 失败后指数退避重试（1s, 2s）
  - 最大重试 2 次
  - 记录失败文件名列表 `failedNames`
- **日志**: 每次重试输出 `[retry] 第N次重试: ...`
- **效果**: 网络抖动导致的临时失败可自动恢复

---

### 17. 多类型文件支持（v1.1.0）

- **日期**: 2026-04-06
- **位置**: `src/content/index.ts`, `src/types/index.ts`
- **扩展前**: 仅支持 PPT/PPTX
- **扩展后**: 支持 11 种文件类型
  - 文档: ppt, pptx, pdf, doc, docx
  - 媒体: mp4, mp3
  - 表格: xls, xlsx
  - 压缩: zip, rar
- **实现**:
  - 新增 `SUPPORTED_TYPES` 常量数组
  - `scanDataBodyFiles()` 改用 `SUPPORTED_TYPES.indexOf()` 判断
  - UI 标题从 "PPT下载器" 改为 "资源下载器"
  - 统一使用 `inferFileType()` 进行类型推断

---

### 18. 设置面板（Popup 双标签页）

- **日期**: 2026-04-06
- **位置**: `src/popup/index.html`, `src/popup/popup.ts`
- **新增 UI**: 
  - 主页/设置双标签页结构
  - 标签导航: `<nav class="tab-nav">` 切换
  - 设置项:
    - 自动扫描开关（页面加载时自动检测）
    - 默认下载方式（弹出保存对话框 / 静默下载）
    - 文件类型过滤（6种类型复选框）
- **持久化**: `chrome.storage.local` 存储设置
- **实时同步**: 设置变更通过 `chrome.tabs.sendMessage` 同步到 Content Script
- **权限**: manifest.json 已包含 `"storage"` 权限

---

### 19. v1.1.0 版本发布

- **日期**: 2026-04-06
- **manifest.json 更新**:
  - `name`: "ChaoXing PPT Downloader" → "超星学习通资源下载器"
  - `version`: "1.0.0" → "1.1.0"
  - `description`: 更新为支持多种资源类型
  - `action.default_title`: "PPT Downloader" → "资源下载器"
- **Git 提交**: 4 个 commit
  - `e0ac222` refactor: 清理Background死代码
  - `a5abc73` refactor: Content Script模块化重构
  - `304502f` feat: 批量下载增强（CORS修复+进度显示+重试机制）
  - `6193da1` feat: v1.1.0 功能扩展（多类型支持+设置面板+UI升级）
- **构建状态**: ✅ 全部通过
  - background/index.js: 2.99 KB (gzip: 1.51 KB)
  - popup/popup.js: 6.27 KB (gzip: 2.66 KB)
  - content/index.js: 11.73 KB (gzip: 5.21 KB)

---

## 关键经验教训（新增）

6. **代码重构要配合 Git 基线**: 大重构前务必打 tag，随时可回档
7. **模块化不是越多越好**: 按功能分区（扫描/下载/UI）比按文件类型分区更直观
8. **用户反馈驱动优先级**: 批量下载的 CORS 问题用户没提，但进度显示是痛点
9. **设置面板需要 storage 权限**: 提前规划权限，避免后期返工
10. **Origin 头是 Chrome 内部强制加的**: 任何 background fetch 都带 `chrome-extension://<id>`,对 Origin 检查严格的服务器一律 403
11. **用户口语描述 ≠ 真实症状**: "脚本索引更新"实际是 CORS 跨域,需要 console 实测才能定位
12. **DevTools 之外的日志能力**: 浮动面板内嵌日志面板 + 一键复制/下载,比让用户开 Console 友好得多

---

## 2026-06-27 开发记录 (v1.1.x 修复)

### 20. Popup 下载按钮无反应 — 消息契约错位

- **日期**: 2026-06-27
- **位置**: `src/popup/popup.ts:182-202`, `src/content/index.ts:799-823`
- **症状**: 工具栏 popup 的"下载"和"批量下载"按钮点击无反应
- **根因**:
  - popup 单个下载发 `DOWNLOAD_SINGLE` → background 无此 case → 进 default → 返回"未知消息类型" → popup 不知情
  - popup 批量下载发 `BATCH_DOWNLOAD_V10` + `ppts` 字段 → background 期望 `files`+`folderName` → `files=undefined` → 0 个文件处理
- **修复**: 改为 popup 通过 `chrome.tabs.sendMessage` 把下载请求转发给 content script(content 已有完整下载逻辑)
  - `TRIGGER_DOWNLOAD` → content 调 `downloadPPTFromContent()`
  - `TRIGGER_BATCH_DOWNLOAD` → content 调 `enqueueBatchDownload()`
- **架构原则**: popup 只做 UI 入口,所有下载逻辑收敛到 content(单一职责)

---

### 21. 跨域 CORS 拦截 — 课程页迁到 mooc2-ans 后 status API 跨域

- **日期**: 2026-06-27
- **位置**: `src/background/index.ts:resolveCdnUrl()`, `src/content/index.ts:fetchStatusAndGetDownloadUrl()`
- **症状**: 
  - 用户报告"学习通更新了脚本索引,原方法失效"
  - 实际控制台报错:
    ```
    Access to fetch at 'https://mooc1.chaoxing.com/ananas/status/...'
    from origin 'https://mooc2-ans.chaoxing.com'
    has been blocked by CORS policy
    net::ERR_FAILED 200 (OK)
    ```
  - 关键: HTTP 200 表示**服务器实际返回成功**,只是响应被浏览器拦截
- **根因**:
  - 学习通把课程资料页从 `mooc1.chaoxing.com` 迁到 `mooc2-ans.chaoxing.com`
  - status API 仍在 `mooc1.chaoxing.com`
  - content script 的 `fetch` 受 CORS 限制
- **修复**: 把 status API 调用从 content 移到 background service worker
  - background 有 `host_permissions` 特权,**不受 CORS 限制**
  - 新增 `RESOLVE_CDN_URL` 消息处理 + `resolveCdnUrl()` 函数
  - content 改为 `chrome.runtime.sendMessage` 调 background

---

### 22. 主页面 404 检测 — 避免在错误页面触发下载

- **日期**: 2026-06-27
- **位置**: `src/content/index.ts:isPageBroken()`, `createBrokenPageUI()`, `injectDownloadButton()`
- **症状**: 用户点下载时,主页面显示 nginx 404 错误页
- **根因**: 
  - 主页面 URL 是 `https://mooc1.chaoxing.com/ananas/preview/{objectId}?courseid=...`
  - preview URL 直接访问时被学习通返回 404
  - 浮动面板虽然注入到 404 页面,但页面状态错乱
- **修复**: 
  - `isPageBroken()` 检测 `document.title === '404'` 或 body 包含 "页面不存在"
  - 404 时显示提示面板("请到课程资料页使用"),不显示下载按钮
  - 404 提示面板也带"📋 日志"按钮(方便调试)

---

### 23. status API 404 优雅降级 — 不再跳到 404 新窗口

- **日期**: 2026-06-27
- **位置**: `src/content/index.ts:ResourceNotFoundError`, `downloadPPTFromContent()`, `batchDownloadV10()`
- **症状**: 资源已被老师/学习通删除时,fallback 跳到无效 URL,新窗口显示 404 页面
- **根因**: `downloadPPTFromContent` 失败后 fallback 到 `navigateToDownload()` / `window.open()`,但这些 URL 也已失效
- **修复**: 
  - 新增 `ResourceNotFoundError` 异常类
  - `fetchStatusAndGetDownloadUrl()` 在 404 时 reject 该异常
  - content 捕获后 toast 提示"`文件名`: 资源不存在,已跳过",**不再打开任何新窗口**
  - 批量下载时同样处理,跳过 404 文件继续后续文件

---

### 24. 内嵌日志面板 — 不开 DevTools 也能看日志

- **日期**: 2026-06-27
- **位置**: `src/content/index.ts:toggleLogPanel()`, `src/background/index.ts:BG_LOG_BUFFER`
- **背景**: 用户中文界面,不熟悉 DevTools,改用浮动面板内嵌日志
- **实现**:
  - content 和 background 各自维护内存日志 buffer(最近 300 条)
  - 浮动面板加"📋"按钮,点开是暗色日志面板
  - 顶部 4 个按钮: **📋 复制** / **⬇️ 下载 .log** / **清空** / **✕**
  - background 暴露 `GET_LOGS` / `CLEAR_LOGS` 消息
  - content 浮动面板查询时合并 CS + BG 日志显示
- **效果**: 用户出问题直接点"📋 复制"发给我,定位速度大幅提升

---

### 25. background fetch 15s 超时 + 详细错误分支

- **日期**: 2026-06-27
- **位置**: `src/background/index.ts:resolveCdnUrl()`
- **症状**: 日志只有 `[Resolve] URL` 开头,没有 ✅/❌,说明 fetch 卡住
- **根因**: 原始 `fetch` 无超时保护,可能因网络/服务器问题永远不返回
- **修复**:
  - `Promise.race` 加 15s 超时
  - 每个错误分支独立 log(HTTP 非 200 / 返回空 / 非 JSON / timeout)
  - 后续日志能精确定位卡在哪一步

---

### 26. ★★★ background fetch 强制带 `Origin: chrome-extension://<id>` 头导致 403

- **日期**: 2026-06-27
- **位置**: `src/background/index.ts:fetchViaMooc1Tab()`, `waitTabLoad()`, `src/content/index.ts:FETCH_STATUS_API`
- **症状**: 加了 cookie(3 个)+ 显式 Referer + `credentials: 'omit'` 仍然 403
- **根因**(**本次最大发现**):
  - Chrome MV3 background service worker 的 `fetch` 强制带 `Origin: chrome-extension://<id>` 头
  - 这个头**无法用 JS 覆盖**(由 fetch spec 决定)
  - 学习通服务器对非页面 Origin(`chrome-extension://`)一律 403
  - 之前在 console 跑 fetch 是 200,因为 console 的 Origin = 页面 URL(`https://mooc2-ans.chaoxing.com`)
- **修复方案 — "同源代理 tab" 架构**:
  ```
  background 收到 RESOLVE_CDN_URL
    ↓
  1. chrome.tabs.query({url: 'https://mooc1.chaoxing.com/*'})  // 找已有 tab
    ↓
  2. 没有就 chrome.tabs.create({url: 'https://mooc1.chaoxing.com/', active: false})
    ↓
  3. waitTabLoad(tabId, 8000)  // 轮询 status === 'complete'
    ↓
  4. chrome.tabs.sendMessage(tabId, {type: 'FETCH_STATUS_API', url})  // 让那个 tab 的 content 帮 fetch
    ↓
  5. content 在 mooc1 域名下 fetch(同源,Origin = https://mooc1.chaoxing.com)→ 200 OK
  ```
- **新增**:
  - `fetchViaMooc1Tab(url, timeoutMs)` — 找/建 tab + sendMessage
  - `waitTabLoad(tabId, timeoutMs)` — 轮询 tab.status
  - content 端 `FETCH_STATUS_API` 消息 + `fetchStatusApiInPage()`(同源 fetch)
- **代价**: 用户 tab 栏多 1 个后台 mooc1 tab(`active: false`,不会抢焦点,后续复用)
- **manifest 权限**: `cookies` 权限保留(虽然当前未直接用,但 fetchViaMooc1Tab 失败时可作为 fallback)

---

### 27. 当前最终架构 (v1.1.x 修复后)

```
用户点下载
  ↓
content (mooc2-ans 页面上下文,有页面 Cookie)
  ├── 扫描 li.dataBody_file → 解析出 meta(objectId/classId/enc/t)
  ├── chrome.runtime.sendMessage(RESOLVE_CDN_URL, {meta, referer})
  │
  ↓
background
  ├── fetchViaMooc1Tab() ──→ chrome.tabs.sendMessage(mooc1 tab, FETCH_STATUS_API)
  │                              ↓
  │                         [mooc1 tab 的 content]
  │                              ├── fetch(status URL)  // 同源!Origin 正常
  │                              └── 解析出 cdnUrl
  ├── 收到 {success, cdnUrl, isPdf} → sendResponse 给主 content
  │
  ↓
content 收到 cdnUrl
  ├── chrome.runtime.sendMessage(FETCH_AND_DOWNLOAD_V10, {cdnUrl, filename})
  │
  ↓
background
  ├── fetch(cdnUrl) → Blob (cldisk.com CDN,允许 CORS)
  ├── Blob → base64 → dataUrl
  └── chrome.downloads.download({url: dataUrl, filename, saveAs: true})
  │
  ↓
✅ 弹出保存对话框
```

**关键经验**:
- **CORS 拦截 ≠ 服务器拒绝**:`net::ERR_FAILED 200 (OK)` 看着矛盾,实际是请求成功了但响应被浏览器拦截
- **`Origin` 头是终极壁垒**: 这是本次最难发现的一层,JS 改不了,只能换 fetch 上下文
- **同源代理 tab 是终极方案**: 当其他路都走不通时,在目标域名下跑 fetch 是最稳的办法
- **代价要明确**: tab 栏会多一个后台 tab,这是绕不开的 trade-off

---

### 28. v1.1.x 版本对比

| 维度 | v1.1.0 (原版) | v1.1.x (修复后) |
|------|-------------|---------------|
| popup 下载按钮 | ❌ 静默失败 | ✅ 转发给 content |
| 跨域 status API | ❌ CORS 拦截 | ✅ mooc1 tab 同源 fetch |
| 主页面 404 | ❌ 浮动面板错乱 | ✅ 提示页面 |
| 资源被删(404) | ❌ 跳 404 新窗口 | ✅ toast 提示跳过 |
| 日志查看 | ❌ 必须开 DevTools | ✅ 浮动面板📋按钮 |
| fetch 卡死 | ❌ 30s 后 SW 被 kill | ✅ 15s 超时 + 详细日志 |
| background fetch Origin | ❌ chrome-extension Origin → 403 | ✅ 同源 tab 代理 |

---

## 关键经验教训（v1.1.x 新增）

13. **fetch 失败要看完整错误**: `net::ERR_FAILED 200 (OK)` 不是矛盾,是 CORS 拦截响应的典型表现
14. **`Origin` 头是 Chrome 内部强制加的**: background service worker 的 fetch 永远带 `chrome-extension://<id>`,这是 v1.1.x 最难绕过的限制
15. **同源代理 tab 是终极 CORS 解决方案**: 当所有 fetch 配置都试过还失败时,创建一个目标域名的 tab 让 content 在那里 fetch 是最后的手段
16. **浮动面板内嵌日志比引导用户开 DevTools 友好**: 用户是中文界面,内嵌日志 + 一键复制大幅降低沟通成本
17. **检测 404 主页面**: 用户在错误页面触发操作时,扩展应该显示提示而不是强行执行
18. **fallback 路径会放大问题**: 资源被删时,fallback 跳到无效 URL 会让用户看到 404 页面,体验比直接失败更差

---

## 2026-11-19 开发记录 (v1.1.2 维护更新)

### 29. Popup 资源列表重复追加

- **日期**: 2026-11-19
- **位置**: `src/popup/popup.ts:updatePPTList()`
- **症状**: 同一页面多次点击"扫描"，资源列表条目成倍重复
- **根因**: `updatePPTList()` 直接 `appendChild`，从不清空旧列表
- **修复**: 渲染前 `pptListEl.innerHTML = ''`

### 30. 批量下载状态按索引回写导致错位

- **日期**: 2026-11-19
- **位置**: `src/content/index.ts:batchDownloadV10()`
- **症状**: 批量下载中若有资源 404 被跳过，`files` 数组比 `ppts` 短，结果按 `idx` 回写 `ppt.downloaded` 会标记到错误的文件
- **修复**: 构建 `filePptMap: Map<string, PPTResource[]>`（文件名 → 资源队列），结果按 `r.filename` 精确出队回写；同名文件按顺序消费

### 31. 版本号对齐 + LICENSE + README 重写

- **日期**: 2026-11-19
- **问题**: v1.1.1 修复提交未同步版本号（manifest 1.1.0 / package.json 1.0.0）；README 声明 MIT 但 LICENSE 文件缺失；README 链接 `底层逻辑.md`、`.workbuddy/` 等被 gitignore 的文件（GitHub 死链）；CHANGELOG 缺 1.1.0/1.1.1 记录
- **修复**:
  - manifest.json / package.json / package-lock.json / popup 页脚统一 → **1.1.2**
  - 新增 MIT `LICENSE`（Copyright 2026 Erichestein0702）
  - README 重写：v1.1.x 同源代理 tab 架构、多类型/设置/日志面板功能、完整权限表 + 隐私声明、移除死链
  - CHANGELOG 补录 1.1.0 / 1.1.1 / 1.1.2

### 关键经验教训（v1.1.2 新增）

19. **发版必须同步版本号**: 修复提交合入时 manifest/package.json/页脚三处版本号要一起改，否则用户无法分辨扩展是否更新
20. **README 只链接入库文件**: gitignore 的文档（工作记忆/底层逻辑）不要出现在 README 链接里，公开仓库上全是死链
21. **并行数组回写是隐患**: "请求列表"与"结果列表"长度可能不等（跳过/失败），回写状态必须按键（文件名/ID）映射，不能按索引
