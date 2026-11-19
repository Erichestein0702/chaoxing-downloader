# 📥 超星学习通资源下载器

> 自动检测并下载超星学习通课程资源（PPT/PDF/视频/文档等）— Chrome 扩展 (Manifest V3)

[![Version](https://img.shields.io/badge/version-1.1.2-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

---

## ✨ 功能特性

- 🔍 **自动检测** — 扫描课程"资料区"，解析 `toOpen()` 参数提取资源元数据
- 📦 **多类型支持** — PPT / PPTX / PDF / DOC / DOCX / XLS / XLSX / MP4 / MP3 / ZIP / RAR
- 📥 **原生下载** — 单个文件弹出 Chrome"另存为"对话框；批量静默下载到 `Downloads/课程名/` 子文件夹
- 🔁 **失败重试** — 直链获取失败自动重试（指数退避，最多 2 次），批量下载实时进度显示
- 🛡️ **智能降级** — 主路径失败自动切换备用方案；资源被删（404）时优雅跳过，不再弹错误窗口
- 📋 **内嵌日志面板** — 浮动面板一键查看/复制/导出运行日志，无需打开 DevTools
- ⚙️ **设置面板** — 自动扫描开关、下载方式、文件类型过滤（`chrome.storage.local` 持久化）
- 🎯 **零配置** — 安装即用，无需 API Key

## 🚀 快速开始

### 构建安装

```bash
git clone https://github.com/Erichestein0702/chaoxing-downloader.git
cd chaoxing-downloader
npm install
npm run build
```

1. 打开 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择项目的 `dist` 目录

### 使用

1. 登录 [超星学习通](https://i.chaoxing.com) 网页版，进入课程章节/资料页面
2. 页面右上角出现 **📥 资源下载器** 浮动面板（或点击工具栏扩展图标）
3. 点击 **扫描资源** → 显示文件列表
4. 单个点击「下载」弹出保存对话框；**批量下载** 一键全部存入课程子文件夹
5. 出问题点面板 **📋** 按钮查看/复制日志

## 🏗️ 技术架构（v1.1.x）

```
Content Script (mooc2-ans 课程页)
  ├── 扫描 li.dataBody_file → 解析 meta (objectId/classId/enc/t)
  └── sendMessage(RESOLVE_CDN_URL)
        ↓
Background Service Worker
  ├── fetchViaMooc1Tab(): 找/建 mooc1 后台 tab
  │     └── 该 tab 的 content 同源 fetch status API → CDN 直链
  │         (绕过 MV3 SW 强制 Origin: chrome-extension:// 导致的 403)
  ├── fetch(CDN) → Blob → base64 Data URL (SW 无 createObjectURL)
  └── chrome.downloads.download({saveAs: true|false})
```

| 技术 | 用途 |
|------|------|
| Manifest V3 + TypeScript + Vite | 扩展规范 / 类型安全 / 构建 |
| 同源代理 tab | 绕过 background fetch 的 Origin 限制（v1.1.1 核心修复） |
| Data URL 编码 | 解决 SW 无 DOM API 的限制 |
| host_permissions `*.cldisk.com` | Background 跨域 fetch CDN |

> 架构演进的完整踩坑记录见 [DEVELOPMENT_MEMORY.md](./DEVELOPMENT_MEMORY.md)。

## 📁 项目结构

```
src/
├── background/index.ts    # Service Worker：直链解析、下载核心
├── content/index.ts       # 页面注入：DOM 扫描、浮动面板、下载触发
├── content/styles.css     # 浮动面板样式
├── popup/                 # 工具栏弹窗（主页 + 设置双标签）
├── types/index.ts         # 类型定义与文件类型推断
└── manifest.json          # MV3 清单
```

## ⚙️ 权限说明

| 权限 | 用途 |
|------|------|
| `downloads` | 触发 Chrome 原生下载 |
| `activeTab` / `scripting` | 访问当前标签页 |
| `cookies` | 读取超星/CDN 域 Cookie 附加到下载请求（仅发往对应域名） |
| `storage` | 保存设置项 |
| `https://*.chaoxing.com/*` | 页面注入与 status API |
| `https://*.cldisk.com/*` | CDN 文件下载 |

**隐私**：所有网络请求仅指向超星及其 CDN 域名，无任何第三方上报；日志仅存内存，导出需手动操作。

## 🐛 已知限制

1. **后台 tab** — 直链解析需要复用/新建一个 `mooc1.chaoxing.com` 后台标签页（不抢焦点），这是绕过 Origin 限制的代价
2. **大文件内存** — Data URL 编码在超大文件（>100MB）时内存占用较高
3. **依赖 status API** — 超星若变更 `/ananas/status/{objectId}` 接口需同步更新
4. **仅覆盖资料区** — 其他页面区域未全面测试

## 📚 文档

| 文档 | 说明 |
|------|------|
| [DEVELOPMENT_MEMORY.md](./DEVELOPMENT_MEMORY.md) | 错误记录、架构演进、经验教训 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更日志 |

## 🤝 参考与致谢

- [ChaoXingDownload](https://gitee.com/long-teng-feng-zhu/ChaoXingDownload) — 核心下载逻辑参考
- [FxxkStar](https://github.com/chettoy/FxxkStar) — 学习通 API 研究

## 📄 许可证

[MIT License](LICENSE)

---

<p align="center">
  Made with ☕ and lots of debugging<br>
  <sub>如果这个项目帮到了你，欢迎 ⭐ Star 支持！</sub>
</p>