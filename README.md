# Cursor Feedback Extension

一个用于 Cursor/VS Code 的交互式反馈收集插件，让 AI Agent 可以直接在 IDE 侧边栏中与用户交互，无需切换到外部浏览器。

## 功能特性

- 🎯 **侧边栏集成** - 反馈面板直接嵌入 IDE 侧边栏，零上下文切换
- 📝 **文字反馈** - 支持多行文本输入
- 🖼️ **图片上传** - 支持拖拽或点击上传图片
- ⚡ **快捷操作** - 预设常用回复按钮
- ⌨️ **快捷键** - Ctrl+Enter 快速提交
- 🔌 **MCP 协议** - 标准 MCP 协议，与 Cursor AI 无缝集成

## 安装

### 开发模式

```bash
# 克隆仓库
git clone https://github.com/jianger666/cursor-feedback-extension.git
cd cursor-feedback-extension

# 安装依赖
npm install

# 编译
npm run compile

# 在 VS Code/Cursor 中按 F5 启动调试
```

### 配置 MCP

在 Cursor 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "cursor-feedback": {
      "command": "node",
      "args": ["/path/to/cursor-feedback-extension/dist/mcp-server.js"],
      "timeout": 600
    }
  }
}
```

## 使用方法

1. 安装并激活插件后，侧边栏会出现 "Cursor Feedback" 图标
2. 当 AI 调用 `interactive_feedback` 工具时，侧边栏会自动显示反馈表单
3. 输入您的反馈内容，可以添加图片
4. 点击"提交反馈"或按 Ctrl+Enter 发送

## 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `cursorFeedback.serverPort` | number | 8766 | MCP 服务器端口 |
| `cursorFeedback.autoStartServer` | boolean | true | 自动启动 MCP 服务器 |
| `cursorFeedback.language` | string | "zh-CN" | 界面语言 |

## 项目结构

```
cursor-feedback-extension/
├── src/
│   ├── extension.ts        # 插件入口
│   ├── mcp/
│   │   └── McpServer.ts    # MCP 服务器实现
│   └── webview/
│       └── FeedbackPanel.ts # WebView 面板
├── package.json            # 插件配置
└── tsconfig.json           # TypeScript 配置
```

## 开发

```bash
# 监听模式编译
npm run watch

# 代码检查
npm run lint
```

## 致谢

灵感来源于 [mcp-feedback-enhanced](https://github.com/Minidoracat/mcp-feedback-enhanced) 项目。

## 许可证

MIT
