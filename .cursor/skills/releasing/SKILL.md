---
name: releasing
description: 发布 cursor-feedback 新版本到 npm / Open VSX / VS Code Marketplace。当用户要发版、发布新版本、出包、上线、release、publish 时使用。
---

# 发布 cursor-feedback 新版本

发版用 `standard-version` 升级版本号，发布由 GitHub Actions（`.github/workflows/release.yml`，推送 `v*.*.*` tag 触发）自动完成三个渠道。**不要手动 `npm publish` / `vsce publish`。**

## 发版步骤

```
- [ ] 1. 改动已 commit，且遵循 conventional commits（feat: / fix: / chore:）
- [ ] 2. 升级版本：npm run release:patch（或 release:minor / release:major）
- [ ] 3. 推送：git push --follow-tags origin main
- [ ] 4. 验证三渠道发布成功
```

- **第 2 步**：`standard-version` 自动升级 `package.json` 版本、按 commit 生成 CHANGELOG、打 `vX.Y.Z` tag。
- **第 3 步**：推送 tag 后 GitHub Actions 自动发布，去仓库 Actions 页看进度。

## 三个发布渠道

| 渠道 | 认证 | 说明 |
| --- | --- | --- |
| npm | OIDC Trusted Publishing | 免 token、永不过期（已在 npmjs 配 trusted publisher）|
| Open VSX | `OVSX_PAT` secret | Cursor / Windsurf / VSCodium 用户从这装 |
| VS Code Marketplace | `VSCE_PAT` secret | 缺该 secret 时此步骤自动跳过 |

secrets 在 GitHub 仓库 `Settings → Secrets and variables → Actions` 配置。

## 硬约束（踩过的坑，别再犯）

- **禁止给 `package.json` 加 `files` 字段**：会与 `.vscodeignore` 冲突，导致 `vsce package` 直接失败。npm 包瘦身只用 `.npmignore`，VS Code 打包只用 `.vscodeignore`，两者各管各的、互不影响。
- `pre-push` hook 会校验 `package.json` 的 version 已写入 `CHANGELOG.md`，没写会被拦下。

## 验证发布

```bash
npm view cursor-feedback version
curl -s https://open-vsx.org/api/jianger666/cursor-feedback | grep -o '"version":"[^"]*"'
```

两个版本号都应等于刚发的版本。
