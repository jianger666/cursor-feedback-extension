# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [2.1.2](https://github.com/jianger666/cursor-feedback-extension/compare/v2.1.1...v2.1.2) (2026-07-03)


### Bug Fixes

* **mcp:** 多窗口/多对话共用进程的反馈路由修复——按窗口查询 + 重复投递去重 + 暂停保护 ([3b3d451](https://github.com/jianger666/cursor-feedback-extension/commit/3b3d451453ee5a04ce29929845d22191116e0f96))

### [2.1.1](https://github.com/jianger666/cursor-feedback-extension/compare/v2.1.0...v2.1.1) (2026-07-02)


### Bug Fixes

* **mcp:** 等待反馈期间不再被僵尸判定误杀——Connection closed 断连根因修复 ([39cc9d5](https://github.com/jianger666/cursor-feedback-extension/commit/39cc9d5fe5730023069014c8a749841993117efa))

## [2.1.0](https://github.com/jianger666/cursor-feedback-extension/compare/v2.0.5...v2.1.0) (2026-07-02)


### Features

* 快捷回复短语、暂停倒计时、反馈历史、提交轻提示与通知点击唤起 Cursor ([a508754](https://github.com/jianger666/cursor-feedback-extension/commit/a508754d78b72f2673ed2ce625b63ed0bda51a6e))


### Bug Fixes

* **mcp:** 超时空窗的提交/飞书回复不再丢失——暂存续接下一轮 + 多窗口路由修复 ([c136ff3](https://github.com/jianger666/cursor-feedback-extension/commit/c136ff371fb87b57737202ba4dc122e7e3eaa40a))

### [2.0.5](https://github.com/jianger666/cursor-feedback-extension/compare/v2.0.4...v2.0.5) (2026-06-23)


### Bug Fixes

* **mcp:** 根除多窗口取消风暴 + 无插件 host 不再因空闲自杀 ([5333b41](https://github.com/jianger666/cursor-feedback-extension/commit/5333b41a0903b8e16df2ad31cb033796426805fb))


### Chores

* 补齐 release:patch 脚本，与 releasing skill 文档一致 ([ed8a292](https://github.com/jianger666/cursor-feedback-extension/commit/ed8a2927eff7155d2f1ac6c627d9fb9006f6c6f3))

### [2.0.4](https://github.com/jianger666/cursor-feedback-extension/compare/v2.0.3...v2.0.4) (2026-06-22)


### Bug Fixes

* **mcp:** 反馈归属只取 AI 传入的 project_directory，不再被 WORKSPACE_FOLDER_PATHS 带偏 ([b43975f](https://github.com/jianger666/cursor-feedback-extension/commit/b43975f772651725569bb0e578937ef8a52683c9))

### [2.0.3](https://github.com/jianger666/cursor-feedback-extension/compare/v2.0.2...v2.0.3) (2026-06-22)


### Bug Fixes

* **feishu:** 配置指引「找不到」——补打包 docs + stat 校验兜底在线 ([9eebf3c](https://github.com/jianger666/cursor-feedback-extension/commit/9eebf3cd9238f93bc0de9f1c918fd776c1885a4e))

### [2.0.2](https://github.com/jianger666/cursor-feedback-extension/compare/v2.0.1...v2.0.2) (2026-06-20)


### Bug Fixes

* **feishu:** 消息没送到时引用回复提示，去除虚假「已收到」回执 ([52b107d](https://github.com/jianger666/cursor-feedback-extension/commit/52b107d27ee146dcc10ba1a3aa77d18f3f51bb3c))

### [2.0.1](https://github.com/jianger666/cursor-feedback-extension/compare/v2.0.0...v2.0.1) (2026-06-20)


### Bug Fixes

* **feishu:** 卡片标题与引导语去掉 Cursor 绑定改为通用文案 ([07857fa](https://github.com/jianger666/cursor-feedback-extension/commit/07857fa07b972c2a7c621c76fadf33870ddbdb61))


### Code Refactoring

* 发版指引从 rule 改为 skill ([5854980](https://github.com/jianger666/cursor-feedback-extension/commit/58549801b93c37262cca793ceb238d84d2806f2d))


### Chores

* **ci:** 移除 VS Code Marketplace 发布渠道 ([d58fec1](https://github.com/jianger666/cursor-feedback-extension/commit/d58fec19f9285c6705cb3aebe3aae1e4fc595986))


### Documentation

* **feishu:** 删掉与开头重复的结尾段 ([bdc9c61](https://github.com/jianger666/cursor-feedback-extension/commit/bdc9c61fa86c9a268d54d2b777ecc1b11cfb849b))
* **feishu:** 精简事件订阅步骤描述 ([770a486](https://github.com/jianger666/cursor-feedback-extension/commit/770a4869b475a2466c99357b2e8f146582d9e57d))
* **feishu:** 补充事件订阅（长连接）配置步骤 ([47f5656](https://github.com/jianger666/cursor-feedback-extension/commit/47f5656373bec44ff6d3274c7c46b7bc6fa105b3))
* 添加发版流程 rule 供后续 AI 参考 ([e6986a4](https://github.com/jianger666/cursor-feedback-extension/commit/e6986a49d54b279fe28e14d1733342b20b64bbf6))

## [2.0.0](https://github.com/jianger666/cursor-feedback-extension/compare/v1.1.1...v2.0.0) (2026-06-20)


### Features

* 飞书通知打通、通知设置重构与多窗口配置同步 ([fcd536e](https://github.com/jianger666/cursor-feedback-extension/commit/fcd536e295ea2a97250e2eb5c77dec6897e51d60))

## [1.2.0](https://github.com/jianger666/cursor-feedback-extension/compare/v1.1.1...v1.2.0) (2026-06-12)


### Features

* 新增系统级通知：AI 请求反馈且 IDE 窗口未聚焦时，弹出系统原生通知（macOS / Windows / Linux），避免离开时错过反馈请求导致超时；新增 `cursorFeedback.systemNotification` 与 `cursorFeedback.notificationSound` 配置项

### [1.1.1](https://github.com/jianger666/cursor-feedback-extension/compare/v1.1.0...v1.1.1) (2026-06-02)


### Bug Fixes

* update check-changelog script to support standard-version format ([b605ed5](https://github.com/jianger666/cursor-feedback-extension/commit/b605ed5b937364fac7bd98892dfce78885e16877))
* 修复 Cursor 关闭后 MCP server 进程残留及 CPU 占满 ([59dafc0](https://github.com/jianger666/cursor-feedback-extension/commit/59dafc08a5284ac3eb9111b2b1a3592b4412554a))

## 1.1.0 (2026-01-29)


### Features

* add i18n support and language auto-detection ([d2f054d](https://github.com/jianger666/cursor-feedback-extension/commit/d2f054de7d4dd94549a94a8b43a9a02b68cdd9f6))
* complete cursor-feedback extension ([4725c73](https://github.com/jianger666/cursor-feedback-extension/commit/4725c732c4370c8c87076932ce551adce184f179))
* v0.1.10 多项改进 ([f65c12e](https://github.com/jianger666/cursor-feedback-extension/commit/f65c12e9c6aa027fa23c3ca007ffdf824e2be69a))
* v1.0.0 - 简化 MCP Server 生命周期管理 ([7ad1545](https://github.com/jianger666/cursor-feedback-extension/commit/7ad1545859781ecfd4e9995b8223fb538a494925))
* 添加多项新功能 ([304a38a](https://github.com/jianger666/cursor-feedback-extension/commit/304a38ae3ba5172adcb48ab1ab828a2775dbf5c4))
* 添加调试信息显示功能，hover 调试图标可查看端口、路径等诊断信息 ([056c03c](https://github.com/jianger666/cursor-feedback-extension/commit/056c03c9b2f52d5e515348ff348283a67dd8c9cf))


### Bug Fixes

* correct button image size (126x28) ([6812364](https://github.com/jianger666/cursor-feedback-extension/commit/68123641416ee7e38bd33ff54e465f2953789322))
* replace VS Marketplace badges with Open VSX badges to fix parsing error ([eff0f9b](https://github.com/jianger666/cursor-feedback-extension/commit/eff0f9b691baacb80d67e57438f72016a8d8256f))
* specify image dimensions in HTML for consistent rendering ([ffc9be3](https://github.com/jianger666/cursor-feedback-extension/commit/ffc9be32a57e15680c68ac1c0004de91e3f203ab))
* 使用插件启动时间判断新旧请求，避免自动切换到旧请求 ([5b5eb48](https://github.com/jianger666/cursor-feedback-extension/commit/5b5eb48b2f877a898ddb810cb4a960dd5876b59e))
* 修复 tooltip 超出边界导致滚动条闪烁的问题 ([dd6ca14](https://github.com/jianger666/cursor-feedback-extension/commit/dd6ca147828552600f4bea6e1c8d35d074dc2d57))
* 修复多项目窗口互相抢占 feedback 的问题 ([ec3ae2c](https://github.com/jianger666/cursor-feedback-extension/commit/ec3ae2c7de01cfcd72fd97b6128e9b462879cd79))
* 修复调试信息 tooltip 导致滚动条闪烁的问题 ([4d562cc](https://github.com/jianger666/cursor-feedback-extension/commit/4d562ccd3370c3f284c1c2570ed12a18c60bb6bb))
* 修复重启后无法收到新feedback的问题 ([88e2905](https://github.com/jianger666/cursor-feedback-extension/commit/88e290517e6d341c20a2f0c7ede4d7686c22e5ba))


### Documentation

* improve description clarity for better understanding ([84d3b68](https://github.com/jianger666/cursor-feedback-extension/commit/84d3b685fe740364daebe96666b0a3e7f87d1be3))
* 更新 README，优化一键安装 MCP Server 的说明 ([8477ba1](https://github.com/jianger666/cursor-feedback-extension/commit/8477ba15e32a72ef741dfd873f8f7466680209d8))
* 更新 README，移除一键安装 MCP Server 的图像链接 ([84dacd0](https://github.com/jianger666/cursor-feedback-extension/commit/84dacd088458cded188e38a409cd64e6c0246a4d))
* 更新 README，移除禁止右侧窗口显示回复内容的规则 ([74ff72f](https://github.com/jianger666/cursor-feedback-extension/commit/74ff72f88f2bed8bcf6c72269c5418ba346b9c0f))
* 更新 README.md，修正插件名称并添加文件支持说明 ([d8c7b09](https://github.com/jianger666/cursor-feedback-extension/commit/d8c7b099c0724268f5357f2ed226461787ede551))
* 更新 User Rules，添加禁止右侧窗口回复的规则 ([e26fcca](https://github.com/jianger666/cursor-feedback-extension/commit/e26fcca082133805225b6544e0438b2f06d9927f))


### Chores

* add automatic changelog check with husky hooks ([2afac95](https://github.com/jianger666/cursor-feedback-extension/commit/2afac953cec125b5eab8c62f7f32fffda3b55d1f))
* add automatic changelog update script ([66a59d3](https://github.com/jianger666/cursor-feedback-extension/commit/66a59d3b2251ef2c98c65d1084a4932c0d2151c9))
* bump version to 0.1.25 and update README with user rules for better AI interaction ([c350f90](https://github.com/jianger666/cursor-feedback-extension/commit/c350f901e24aa10ed39ea208667042294fc60151))
* bump version to 0.1.33 and enhance feedback request handling with workspace and server start time tracking ([5f5d82c](https://github.com/jianger666/cursor-feedback-extension/commit/5f5d82c398f1505aa996e93f1043a09cb700b58d))
* bump version to 0.1.8 ([b77a2df](https://github.com/jianger666/cursor-feedback-extension/commit/b77a2dfb4c56a1743cc5d3301695854ac1ee165b))
* bump version to 1.0.9 and update icon ([ce1f310](https://github.com/jianger666/cursor-feedback-extension/commit/ce1f31081eaab77cd41769821fa06dc1b4c20fed))
* remove custom changelog script (replaced by standard-version) ([0f72cca](https://github.com/jianger666/cursor-feedback-extension/commit/0f72ccac85fef196ab13f3a5e16bbb25c0df36a3))
* replace custom script with standard-version for changelog automation ([3e9be86](https://github.com/jianger666/cursor-feedback-extension/commit/3e9be86c711be0f52012420f54825de32d341da1))
* replace SVG button with PNG for VSCE compatibility ([e821905](https://github.com/jianger666/cursor-feedback-extension/commit/e8219053382e4eefa918b95e3712badfa8ea2680))
* v1.0.1 - 优化工具描述 ([529088b](https://github.com/jianger666/cursor-feedback-extension/commit/529088b6e1c3b93139a2ceed87ec2ba9ef99ae84))
* v1.0.2 - 更新 WebView 结构与样式 ([4e91d00](https://github.com/jianger666/cursor-feedback-extension/commit/4e91d009f4224781eada94d4ab8389c01ea94fad))
* v1.0.4 - 更新版本与优化用户反馈体验 ([359f870](https://github.com/jianger666/cursor-feedback-extension/commit/359f8700dc527dc70123ea62e483628352fcd967))
* v1.0.5 - 更新版本并优化 README 中一键安装 MCP Server 的描述 ([7d21c8e](https://github.com/jianger666/cursor-feedback-extension/commit/7d21c8e9619ddb75603abc3b94c13237913df341))
* v1.0.6 - update version and add icon to package.json ([a7575b2](https://github.com/jianger666/cursor-feedback-extension/commit/a7575b258a92491bb7c1a9d3ede0f47decbbc7ad))
* 将并行端口扫描范围从30减少到20 ([d1e0ee5](https://github.com/jianger666/cursor-feedback-extension/commit/d1e0ee55c83701a4cbc98aa97c6032fc7e7ebdb7))
* 添加 .env 到 gitignore ([ed1065b](https://github.com/jianger666/cursor-feedback-extension/commit/ed1065b78ead0ad65565f84aa75dee40a6f620bd))

## [1.0.9](https://github.com/jianger666/cursor-feedback-extension/releases/tag/v1.0.9) (2026-01-29)

### Chores

* update icon and bump version to 1.0.9

## [1.0.6](https://github.com/jianger666/cursor-feedback-extension/releases/tag/v1.0.6) (2025-01-29)

### Bug Fixes

* specify image dimensions in HTML for consistent rendering
* correct button image size (126x28)

### Chores

* replace SVG button with PNG for VSCE compatibility

## [1.0.5](https://github.com/jianger666/cursor-feedback-extension/releases/tag/v1.0.5)

### Chores

* 更新版本并优化 README 中一键安装 MCP Server 的描述

### Docs

* 更新 README，移除一键安装 MCP Server 的图像链接
* 更新 README，优化一键安装 MCP Server 的说明

## [1.0.4](https://github.com/jianger666/cursor-feedback-extension/releases/tag/v1.0.4)

### Chores

* 更新版本与优化用户反馈体验

## [1.0.2](https://github.com/jianger666/cursor-feedback-extension/releases/tag/v1.0.2)

### Chores

* 更新 WebView 结构与样式

## [1.0.1](https://github.com/jianger666/cursor-feedback-extension/releases/tag/v1.0.1)

### Chores

* 优化工具描述

## [1.0.0](https://github.com/jianger666/cursor-feedback-extension/releases/tag/v1.0.0)

### Features

* 简化 MCP Server 生命周期管理
* 侧边栏集成 - 直接在 IDE 侧边栏中显示反馈界面
* 交互式反馈 - AI Agent 可以通过 MCP 工具请求用户反馈
* 图片支持 - 支持上传图片或直接粘贴（Ctrl+V / Cmd+V）
* 文件支持 - 支持选择文件/文件夹，将路径告诉 AI 让其读取
* Markdown 渲染 - AI 摘要支持完整的 Markdown 格式
* 超时自动重试 - 默认 5 分钟超时，超时后 AI 会自动重新请求反馈
* 多语言支持 - 支持简体中文、繁体中文和英文
* 项目隔离 - 多窗口同时使用时，各项目互不干扰
