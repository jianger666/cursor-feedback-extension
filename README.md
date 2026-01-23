# Cursor Feedback

一个用于 Cursor/VS Code 的交互式反馈收集工具，类似于 [mcp-feedback-enhanced](https://github.com/Minidoracat/mcp-feedback-enhanced)，但使用 TypeScript 重写，并以侧边栏形式嵌入 IDE。

## ✨ 特性

- 🎯 **侧边栏集成** - 直接在 IDE 侧边栏中显示反馈界面，无需打开外部浏览器
- 💬 **交互式反馈** - AI Agent 可以通过 MCP 工具请求用户反馈
- 🖼️ **图片支持** - 支持上传图片作为反馈的一部分
- 📝 **Markdown 渲染** - AI 摘要支持完整的 Markdown 格式
- ⏱️ **超时控制** - 支持配置反馈等待超时时间
- 🌍 **多语言支持** - 支持简体中文、繁体中文和英文
- 🔒 **项目隔离** - 多窗口同时使用时，各项目互不干扰

## 🚀 快速开始

### 1. 配置 MCP Server

#### 方式 A：使用 npx（推荐）

在 Cursor 的 MCP 配置文件中添加（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "cursor-feedback": {
      "command": "npx",
      "args": ["-y", "@jianger666/cursor-feedback"]
    }
  }
}
```

#### 方式 B：全局安装

```bash
npm install -g @jianger666/cursor-feedback
```

然后配置：

```json
{
  "mcpServers": {
    "cursor-feedback": {
      "command": "cursor-feedback-mcp"
    }
  }
}
```

### 2. 安装 VS Code 插件

#### 方式 A：从源码构建

```bash
git clone https://github.com/jianger666/cursor-feedback-extension.git
cd cursor-feedback-extension
npm install
npm run compile
```

然后在 Cursor 中按 F5 运行调试，或打包为 .vsix 安装。

#### 方式 B：从 VS Code Marketplace 安装（即将上线）

搜索 "Cursor Feedback" 安装。

### 3. 使用

1. 重启 Cursor
2. 侧边栏会出现 **Cursor Feedback** 图标
3. 在聊天中让 AI 调用 `interactive_feedback` 工具

## 📖 MCP 工具

### interactive_feedback

交互式反馈收集工具。

**参数:**

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `project_directory` | string | `.` | 项目目录路径 |
| `summary` | string | `I have completed the task you requested.` | AI 工作摘要（支持 Markdown） |
| `timeout` | number | `600` | 超时时间（秒） |

**返回:**

用户反馈内容，包括文字和图片。

### get_system_info

获取系统环境信息。

## ⚙️ 配置选项

在 VS Code/Cursor 设置中可以配置：

| 设置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `cursorFeedback.serverPort` | number | `5678` | MCP Server HTTP 端口 |
| `cursorFeedback.autoStartServer` | boolean | `true` | 是否自动开始监听 |
| `cursorFeedback.language` | string | `zh-CN` | 界面语言 |

## 🏗️ 架构

```
┌─────────────────┐     stdio      ┌──────────────────┐
│   AI Agent      │ ◄──────────► │   MCP Server     │
│   (Cursor)      │               │  (mcp-server.js) │
└─────────────────┘               └────────┬─────────┘
                                           │ HTTP API
                                           ▼
                                  ┌──────────────────┐
                                  │  VS Code 插件     │
                                  │  (extension.js)  │
                                  └────────┬─────────┘
                                           │ WebView
                                           ▼
                                  ┌──────────────────┐
                                  │   用户界面        │
                                  │   (侧边栏)       │
                                  └──────────────────┘
```

## 📊 与 mcp-feedback-enhanced 对比

| 功能 | mcp-feedback-enhanced | cursor-feedback |
|------|:--------------------:|:---------------:|
| MCP 工具 | ✅ | ✅ |
| 文字反馈 | ✅ | ✅ |
| 图片上传 | ✅ | ✅ |
| Markdown 渲染 | ✅ | ✅ |
| 多语言支持 | ✅ | ✅ |
| **IDE 侧边栏集成** | ❌ | ✅ |
| **多窗口项目隔离** | ❌ | ✅ |
| 命令执行 | ✅ | ⏳ |

## 🛠️ 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式
npm run watch

# 运行 lint
npm run lint
```

## 📄 许可证

MIT

## 🙏 致谢

- [mcp-feedback-enhanced](https://github.com/Minidoracat/mcp-feedback-enhanced) - 原始 Python 实现
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 协议
