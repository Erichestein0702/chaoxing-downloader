# 📥 ChaoXing PPT Downloader

> 超星学习通 PPT/PPTX 资源一键下载器 — Chrome 扩展

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-orange.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)

---

## ✨ 功能特性

- 🔍 **自动检测** — 自动扫描超星学习通"资料区"中的所有 PPT/PPTX 文件
- 📥 **原生下载** — 弹出 Chrome 原生"另存为"对话框，自由选择保存位置
- 📦 **批量下载**（实验性）— 一键下载所有文件到指定子文件夹
- 🛡️ **智能降级** — 主路径失败时自动切换备用方案，确保可用性
- 🎯 **零配置** — 安装即用，无需 API Key 或额外设置

## 📸 使用效果

1. 打开超星学习通课程资料页面
2. 页面右上角出现下载器面板
3. 点击「扫描PPT」→ 显示检测到的文件列表
4. 点击「下载」→ Chrome 弹出保存对话框 → 选择位置 → 完成！

```
┌─────────────────────────────┐
│  📥 PPT下载器           ✕   │
├─────────────────────────────┤
│  已发现 5 个                 │
│                             │
│  ┌───────────────────────┐  │
│  │ 批量下载 (5)          │  │
│  └───────────────────────┘  │
│                             │
│  检测到 5 个PPT              │
│  ┌─────────────────────┐    │
│  │ [PPTX] 1. 课程导学... [已下载] │    │ ← 单个：弹对话框
│  │ [PPTX] 2. 第一章...  [下载]   │
│  │ [PPTX] 3. 第二章...  [下载]   │
│  │ [PPTX] 4. 第四章...  [下载]   │
│  │ [PPTX] 5. 第三章...  [下载]   │
│  └─────────────────────┘    │
└─────────────────────────────┘
```

## 🚀 快速开始

### 安装

```bash
# 克隆项目
git clone <repository-url>
cd chaoxing

# 安装依赖
npm install

# 构建
npm run build
```

### 加载到 Chrome

1. 打开 `chrome://extensions/`
2. 开启右上角 **🔧 开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择项目的 `dist` 目录
5. ✅ 扩展图标出现在工具栏

### 使用

1. 登录 [超星学习通](https://i.chaoxing.com) 网页版
2. 进入任意课程的章节/资料页面
3. 页面右上角自动出现 **📥 PPT下载器** 面板
4. 点击 **扫描PPT**
5. 单个文件点击对应「下载」按钮，或点击「批量下载」一键全部

## 🏗️ 技术架构

```
┌──────────────────┐     sendMessage      ┌──────────────────┐
│  Content Script  │ ──────────────────→  │ Background SW    │
│  (学习通页面注入) │                       │ (Service Worker) │
│                  │ ←──────────────────  │                  │
│  ① DOM扫描       │    下载结果          │  ② fetch CDN     │
│  ② 同域fetch API │                      │  ③ Data URL编码   │
│  ③ 解析CDN直链   │                      │  ④ 触发下载      │
└──────────────────┘                      └──────────────────┘
       │                                         │
       ▼                                         ▼
┌──────────────────┐                     ┌──────────────────┐
│ mooc1.chaoxing.com│                    │ s3.cldisk.com    │
│ /ananas/status/  │  → JSON含CDN地址    │ 返回 PDF Blob    │
└──────────────────┘                     └──────────────────┘
                                                  │
                                          chrome.downloads.download()
                                          saveAs: true → "另存为"对话框
```

### 核心技术点

| 技术 | 用途 |
|------|------|
| Manifest V3 | Chrome 最新扩展规范 |
| TypeScript | 类型安全 |
| Vite | 现代化构建 |
| Content Script 注入 | 页面 DOM 操作 |
| Service Worker | 后台跨域请求 + 下载管理 |
| Data URL 编码 | 解决 SW 无 DOM API 的限制 |

详细技术文档请查看 [底层逻辑.md](./底层逻辑.md)

## 📁 项目结构

```
src/
├── background/index.ts    # 后台服务：下载核心逻辑
├── content/index.ts       # 内容脚本：页面注入、DOM扫描、UI
├── content/styles.css      # 浮动面板样式
├── popup/                 # 扩展图标弹窗
├── types/index.ts         # TypeScript 类型定义
└── manifest.json          # MV3 扩展清单
```

## ⚙️ 权限说明

本扩展需要的权限：

| 权限 | 用途 |
|------|------|
| `downloads` | 触发 Chrome 原生下载 |
| `activeTab` | 访问当前标签页内容 |
| `https://mooc1.chaoxing.com/*` | 学习通主站（Content Script 注入） |
| `https://*.cldisk.com/*` | CDN 文件服务器（Background 跨域下载） |

## 🐛 已知限制

1. **批量下载实验性** — 批量静默下载功能存在 CORS 兼容问题待修复，建议使用单个下载
2. **仅支持资料区** — 当前版本主要针对课程"资料区"的 PPT 资源，其他区域未全面测试
3. **依赖 status API** — 如果超星变更 `/ananas/status/{objectId}` 接口格式需要同步更新
4. **大文件** — 超大文件（>100MB）的 Data URL 编码可能占用较多内存

## 📚 项目文档

| 文档 | 说明 | 面向读者 |
|------|------|----------|
| [底层逻辑.md](./底层逻辑.md) | 完整技术文档：工作流程、历史演进、知识点汇总 | 开发者 |
| [DEVELOPMENT_MEMORY.md](./DEVELOPMENT_MEMORY.md) | 开发错误与修复记录、架构演进、经验教训 | Bug 修复者 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更日志与迭代历史 | 所有参与者 |
| [.workbuddy/memory/2026-04-04.md](./.workbuddy/memory/2026-04-04.md) | 每日工作日志（开发过程详细记录） | 开发者 |
| [.workbuddy/memory/MEMORY.md](./.workbuddy/memory/MEMORY.md) | 项目长期记忆：版本体系、关键决策 | 项目维护者 |

### 文档维护规范

- **代码变更时必须同步更新相关文档**
- **错误修复后更新 DEVELOPMENT_MEMORY.md**
- **重大版本变更时更新 MEMORY.md 和 CHANGELOG.md**
- **每日开发工作记录到日期日志文件**

---

## 📊 版本历史

查看 [CHANGELOG.md](./CHANGELOG.md) 了解完整的版本迭代记录。

从 v0.3 到 v1.0 经历了 9 个主要版本的迭代，核心突破在于：
> **利用 Background Service Worker 的 host_permissions 绕过 CORS + Data URL 方案解决 SW 无 DOM API 限制**

## 🤝 参考与致谢

- [ChaoXingDownload](https://gitee.com/long-teng-feng-zhu/ChaoXingDownload) — 核心下载逻辑参考
- [FxxkStar](https://github.com/chettoy/FxxkStar) — 学习通 API 研究

## 📄 许可证

MIT License

---

<p align="center">
  Made with ☕ and lots of debugging<br>
  <sub>如果这个项目帮到了你，欢迎 ⭐ Star 支持！</sub>
</p>
