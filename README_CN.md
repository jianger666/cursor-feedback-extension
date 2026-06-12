# Cursor Feedback

[English](./README.md)

[![Open VSX Version](https://img.shields.io/open-vsx/v/jianger666/cursor-feedback)](https://open-vsx.org/extension/jianger666/cursor-feedback)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/jianger666/cursor-feedback)](https://open-vsx.org/extension/jianger666/cursor-feedback)
[![npm](https://img.shields.io/npm/v/cursor-feedback)](https://www.npmjs.com/package/cursor-feedback)

**一次 Cursor 对话，无限 AI 交互** - 节省你的月度请求配额！通过 MCP（Model Context Protocol）实现一次对话内无限交互的交互式反馈工具。

![Demo](./demo.gif)

## 💡 为什么选择 Cursor Feedback？

如果你使用的是 Cursor 的 500次/月 计划，每次对话都很珍贵。使用 Cursor Feedback：

- **一次对话，无限交互** - 持续聊天而不消耗额外配额
- **人机协作工作流** - AI 等待你的反馈后再继续
- **侧边栏集成** - 无需打开外部浏览器，一切都在 IDE 内完成

灵感来自 [mcp-feedback-enhanced](https://github.com/Minidoracat/mcp-feedback-enhanced)，使用 TypeScript 重写。

## ✨ 特性

- 🎯 **侧边栏集成** - 直接在 IDE 侧边栏中显示反馈界面，无需打开外部浏览器
- 💬 **交互式反馈** - AI Agent 可以通过 MCP 工具请求用户反馈
- 🖼️ **图片支持** - 支持上传图片或直接粘贴（Ctrl+V / Cmd+V）
- 📁 **文件支持** - 支持选择文件/文件夹，将路径告诉 AI 让其读取
- 📝 **Markdown 渲染** - AI 摘要支持完整的 Markdown 格式
- ⏱️ **超时自动重试** - 默认 5 分钟超时，超时后 AI 会自动重新请求反馈
- 🌍 **多语言支持** - 支持简体中文、繁体中文和英文
- 🔒 **项目隔离** - 多窗口同时使用时，各项目互不干扰

## 🚀 快速开始

### 1. 安装 Cursor 插件

在 Cursor 扩展商店搜索 **"Cursor Feedback"** 安装。

> **如果搜索不到？** 可以通过命令行安装：
> ```bash
> cursor --install-extension jianger666.cursor-feedback
> ```

### 2. 配置 MCP Server

#### 方式 A：一键安装（推荐）

点击下方按钮，自动配置 MCP Server：

<a href="https://cursor.com/en/install-mcp?name=cursor-feedback&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImN1cnNvci1mZWVkYmFja0BsYXRlc3QiXX0%3D">
  <img src="mcp-install-dark.png" alt="Install MCP Server" width="126" height="28" />
</a>

#### 方式 B：手动配置

在 Cursor 的 MCP 配置文件中添加（`~/.cursor/mcp.json`）：

```json
{
  "mcpServers": {
    "cursor-feedback": {
      "command": "npx",
      "args": ["-y", "cursor-feedback@latest"]
    }
  }
}
```

#### 方式 C：全局安装

```bash
npm install -g cursor-feedback
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

### 3. 使用

1. 重启 Cursor
2. 侧边栏会出现 **Cursor Feedback** 图标
3. 在聊天中让 AI 调用 `interactive_feedback` 工具
4. AI 会在侧边栏显示工作摘要，等待您的反馈

### 4. 配置 User Rules（推荐）

为了让 AI 更好地使用 Cursor Feedback，建议在 Cursor 设置中添加以下 User Rules：

```
# Cursor Feedback 规则

1. 在任何流程、任务、对话进行时，无论是询问、回复、或完成阶段性任务，皆必须调用 MCP cursor-feedback。
2. 每当收到用户反馈，必须再次调用 MCP cursor-feedback，并根据反馈内容调整行为。
3. 完成任务前，必须使用 MCP cursor-feedback 工具向用户询问反馈。
4. 所有需要展示给用户的内容必须全部通过 cursor-feedback 的 summary 参数传递。
```

配置后，AI 会在对话过程中自动调用 Cursor Feedback 工具，所有回复内容都会通过侧边栏展示，实现持续的交互式对话。

## 📖 MCP 工具

### interactive_feedback

交互式反馈收集工具。

**参数:**

| 参数 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `project_directory` | string | `.` | 项目目录的绝对路径（用于多窗口项目隔离） |
| `summary` | string | `I have completed the task you requested.` | AI 工作摘要（支持 Markdown） |
| `timeout` | number | `300` | 超时时间（秒），默认 5 分钟 |

**超时机制:**

- 默认等待用户反馈 5 分钟（300 秒）
- 超时后 AI 会收到超时通知
- AI 会根据工具指令自动重新调用此工具，继续等待用户反馈
- 这样即使您暂时离开，回来后 AI 仍会等待您的反馈

**返回:**

用户反馈内容，包括文字、图片和附加文件路径。

## ⚙️ 配置选项

### 语言设置

**方式 1：点击侧边栏的 🌐 按钮**（推荐）

在 Cursor Feedback 侧边栏点击地球图标即可切换语言。

**方式 2：通过 VS Code 设置**

在设置中搜索 "Cursor Feedback"：

| 设置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `cursorFeedback.language` | string | `zh-CN` | 界面语言 |

可选语言：
- `zh-CN` - 简体中文
- `en` - English

### 系统通知

当 AI 请求反馈而 IDE 窗口**未聚焦**时（比如您切去做别的事了），插件会发送系统原生通知（macOS / Windows / Linux），避免错过反馈请求导致超时。

| 设置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `cursorFeedback.systemNotification` | boolean | `true` | AI 请求反馈且 IDE 未聚焦时弹出系统通知 |
| `cursorFeedback.notificationSound` | boolean | `true` | 系统通知附带提示音 |

> macOS 说明：通知通过 `osascript` 发送。如果看不到通知，请在 系统设置 → 通知 中允许"脚本编辑器"（Script Editor）发送通知。

### MCP Server 配置示例

基本配置：

```json
{
  "mcpServers": {
    "cursor-feedback": {
      "command": "npx",
      "args": ["-y", "cursor-feedback@latest"]
    }
  }
}
```

配置超时时间（可选，默认 5 分钟）：

```json
{
  "mcpServers": {
    "cursor-feedback": {
      "command": "npx",
      "args": ["-y", "cursor-feedback@latest"],
      "env": {
        "MCP_FEEDBACK_TIMEOUT": "600"
      }
    }
  }
}
```

| 环境变量 | 默认值 | 描述 |
|---------|--------|------|
| `MCP_FEEDBACK_TIMEOUT` | `300` | 超时时间（秒），默认 5 分钟 |
| `MCP_AUTO_RETRY` | `true` | 超时后是否提示 AI 自动重试。设为 `false` 可禁用自动重试指示 |

> **超时机制**：如果用户在超时时间内没有响应，AI 会收到超时通知。默认情况下，返回消息会包含重试指示，AI 会自动重新调用 feedback 工具继续等待。如果您不希望 AI 自动重试，可以设置 `MCP_AUTO_RETRY=false`。

## 🏗️ 架构

```
┌─────────────────┐     stdio      ┌──────────────────┐
│   AI Agent      │ ◄──────────► │   MCP Server     │
│   (Cursor)      │               │  (mcp-server.js) │
└─────────────────┘               └────────┬─────────┘
                                           │ HTTP API
                                           ▼
                                  ┌──────────────────┐
                                  │  Cursor 插件      │
                                  │  (extension.js)  │
                                  └────────┬─────────┘
                                           │ WebView
                                           ▼
                                  ┌──────────────────┐
                                  │   用户界面        │
                                  │   (侧边栏)       │
                                  └──────────────────┘
```

**工作流程:**

1. AI Agent 通过 stdio 调用 MCP Server 的 `interactive_feedback` 工具
2. MCP Server 创建反馈请求，通过 HTTP API 暴露给 Cursor 插件
3. Cursor 插件通过轮询获取请求，在侧边栏 WebView 中显示
4. 用户输入反馈（文字/图片/文件），提交后通过 HTTP 返回给 MCP Server
5. MCP Server 将反馈结果返回给 AI Agent

## 📊 与 mcp-feedback-enhanced 对比

| 功能 | mcp-feedback-enhanced | cursor-feedback |
|------|:--------------------:|:---------------:|
| MCP 工具 | ✅ | ✅ |
| 文字反馈 | ✅ | ✅ |
| 图片上传 | ✅ | ✅ |
| 图片粘贴 | ✅ | ✅ |
| 文件/文件夹选择 | ❌ | ✅ |
| Markdown 渲染 | ✅ | ✅ |
| 多语言支持 | ✅ | ✅ |
| 超时自动重试 | ✅ | ✅ |
| **IDE 侧边栏集成** | ❌ | ✅ |
| **多窗口项目隔离** | ❌ | ✅ |
| 命令执行 | ✅ | ⏳ |

## 🛠️ 开发

```bash
# 克隆项目
git clone https://github.com/jianger666/cursor-feedback-extension.git
cd cursor-feedback-extension

# 安装依赖
npm install

# 编译
npm run compile

# 监听模式
npm run watch

# 运行 lint
npm run lint

# 打包插件
npx vsce package
```

## 📄 许可证

MIT

## 🙏 致谢

- [mcp-feedback-enhanced](https://github.com/Minidoracat/mcp-feedback-enhanced) - 原始 Python 实现
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP 协议
