# Cursor Feedback

[English](./README.md)

[![Open VSX Version](https://img.shields.io/open-vsx/v/jianger666/cursor-feedback)](https://open-vsx.org/extension/jianger666/cursor-feedback)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/jianger666/cursor-feedback)](https://open-vsx.org/extension/jianger666/cursor-feedback)
[![npm](https://img.shields.io/npm/v/cursor-feedback)](https://www.npmjs.com/package/cursor-feedback)

**一次对话，无限 AI 交互** - 如果你是按次计费的用户，它能帮你省下月度请求配额；还能把 Cursor 和飞书打通——AI 请求反馈时推到飞书，你在手机上就能回，甚至发 `/new` 直接拉起新会话。为 Cursor 量身打造的交互式反馈工具（基于 MCP）。

![Demo](./demo.gif)

## 💡 为什么选择 Cursor Feedback？

如果你使用的是 Cursor 的 500次/月 计划或其它 coding plan，每次对话都很珍贵。使用 Cursor Feedback：

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
- 🔔 **飞书打通** - AI 请求反馈时把摘要推送到飞书，你直接在手机上回复，不用守在电脑前
- 📱 **手机拉起会话** - 飞书发 `/new 任务` 直接拉起一轮 Cursor CLI 会话，人不在电脑前也能开工
- 🌙 **常驻服务** - 可选的开机自启守护进程：Cursor 不开也能收发飞书消息，接电源自动防睡眠
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
| `project_directory` | string | 必填 | 当前所在项目空间的根目录绝对路径（你打开的工作区；用于多窗口隔离） |
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

### 通知设置

在反馈面板顶部点「通知设置」图标即可配置插件通知与飞书通知，也可在 VS Code 设置里调整：

| 设置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `cursorFeedback.systemNotification` | boolean | `true` | 插件通知（主开关）：AI 请求反馈时自动弹出反馈面板。关闭后本窗口完全静默——不弹面板、不抢焦点、也不推送消息到本窗口 |
| `cursorFeedback.osNotification` | boolean | `true` | 切到后台时提醒（子项）：IDE 窗口未聚焦时才弹系统原生通知。关闭后即使切走也不弹（面板照常弹出） |
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

> **超时续期**：超时后默认返回续期提示，AI 会自动再次调用 feedback 继续等待；不想自动续期可设 `MCP_AUTO_RETRY=false`。也可在反馈面板顶部「超时续期」开关随时切换（优先级：面板 > env > 默认开）。

### 飞书通知配置

两种方式都行——但都要先在飞书后台把机器人配好：开启机器人能力、申请权限、配置**事件订阅**（长连接方式 + `im.message.receive_v1` 事件）。完整步骤见[飞书配置教程](./docs/feishu-setup.md)：

- **面板配置（推荐）**：在插件面板顶部「通知设置」图标里填飞书凭证。
- **env 配置**（适合把配置固化在 `mcp.json` 里 / 团队统一分发）：

```json
{
  "mcpServers": {
    "cursor-feedback": {
      "command": "npx",
      "args": ["-y", "cursor-feedback@latest"],
      "env": {
        "FEISHU_APP_ID": "cli_xxxxxxxx",
        "FEISHU_APP_SECRET": "your_app_secret"
      }
    }
  }
}
```

| 环境变量 | 默认值 | 描述 |
|---------|--------|------|
| `FEISHU_APP_ID` | - | 飞书应用 App ID（形如 `cli_xxxxxxxx`） |
| `FEISHU_APP_SECRET` | - | 飞书应用 App Secret |
| `FEISHU_ENABLED` | `true` | 是否推送反馈到飞书，设 `false` 关闭 |
| `FEISHU_ACK` | `true` | 收到你的回复后是否回「Get」表情回执，设 `false` 关闭 |
| `FEISHU_QUEUE` | `true` | 忙时消息排队：AI 正忙（没有等待中的反馈）时你发的消息先排队，等 AI 下一轮询问时自动送达并附「任务期间追加」提示；排队时机器人会回执「已排队，任务完成后自动读取」。设 `false` 关闭（也可在面板「通知设置」里切换） |

> 优先级：**插件面板（填了凭证）> 这里的 env > 默认**。面板里填了 App ID/Secret 就以面板为准；没填则回退到 env。首次仍需在飞书里给机器人发一条消息完成绑定。

配置好后，在飞书里给机器人发任意一条消息完成**首次绑定**——server 会把这个会话记为推送目标（落盘、跨进程共享）。之后：Agent 调 `interactive_feedback` → 卡片推到飞书 → 你在飞书回复 → 回复作为工具结果路由回 Agent。手机上就能回，不用守着电脑。

### 手机飞书拉起 CLI 会话（/new）

人不在电脑前，也能从手机飞书发起一轮全新的 AI 会话。前提：本机装好并登录过 [Cursor CLI](https://cursor.com/cli)（`cursor-agent`）。

在与机器人的会话里直接发：

| 命令 | 作用 |
|------|------|
| `/new 任务描述` | 拉起一个 headless CLI 会话跑这个任务（默认在主目录） |
| `/new /绝对路径 任务描述` | 指定工作目录拉起 |
| `/new 项目名 任务描述` | 在 Cursor 打开过的项目里拉起（目录名唯一匹配） |
| `/projects` | 列出 Cursor 打开过的项目路径（供查路径 / 复制给 `/new`） |
| `/status` | 查看运行中会话状态（任务、已运行时长、模型） |
| `/stop` | 终止运行中的 CLI 会话 |
| `/model [模型id]` | 查看 / 设置会话模型（持久化） |
| `/help` | 查看命令用法 |

- 会话以**非交互模式**运行，通过 `--model` 参数指定模型。
- 拉起的 Agent 也通过本插件的反馈卡片与你沟通：需要确认、汇报进展都会推到飞书，直接回复卡片即可。
- 可在 `~/.cursor-feedback/cli-rules.md` 写自定义规则（如「永远用中文」），每次 `/new` 自动注入。
- 会话结束（完成 / 异常 / `/stop` / 超 3 小时兜底终止）都会发飞书收尾消息附最终输出。

### 常驻服务（IDE 关闭也可用）

默认情况下 server 进程由 Cursor 拉起，Cursor 一关飞书链路就断。打开**常驻服务**后，一个独立的守护进程会开机自启，Cursor 开不开都能收发飞书消息、响应 `/new`：

- **开启方式**：插件面板「通知设置」里打开「常驻服务」开关；或命令行 `npx cursor-feedback@latest install-daemon`（卸载对应 `uninstall-daemon`，状态 `daemon-status`）。
- **实现**：把当前包完整拷贝到 `~/.cursor-feedback/daemon/app`（自包含，不怕 npx 缓存被清），macOS 注册 launchd（崩溃自动拉起），Windows 注册登录计划任务。
- **自动升级**：守护拷贝不会「静默落后」——IDE 里的新版 server 启动时发现守护版本旧了，会静默重装并重启守护，无需手动操作。
- **防睡眠**：守护进程在接电源时自动阻止系统睡眠（macOS `caffeinate -s`；Windows 电源断言），电池供电不生效、不偷耗电。锁屏本来就不影响后台进程。
- **典型用法**：下班插着电源锁屏走人，手机飞书随时 `/new`。

### 诊断包导出

server 日志会同时落盘到 `~/.cursor-feedback/logs/`（按天切割，保留 7 天）。在插件「通知设置」里点**导出诊断包**，一键保存包含最近日志、环境信息和脱敏配置（密钥打码）的报告文件，报 bug 时直接附上。即使 server 全挂了也能导（降级为直接读日志文件）。
- 升级插件版本后重新开关一次即可更新守护进程里的拷贝。

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
