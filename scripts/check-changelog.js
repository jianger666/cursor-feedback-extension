#!/usr/bin/env node

/**
 * 检查 changelog 是否需要更新
 * 如果 package.json 中的版本号不在 changelog 中，提示运行 npm run release
 */

const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');

try {
  // 读取 package.json 获取当前版本
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const currentVersion = packageJson.version;

  // 读取 CHANGELOG.md
  const changelog = fs.readFileSync(changelogPath, 'utf8');

  // 检查是否已经包含当前版本
  const versionPattern = new RegExp(`## \\[${currentVersion.replace(/\./g, '\\.')}\\]`, 'i');
  
  if (!versionPattern.test(changelog)) {
    console.error('\n❌ 警告：CHANGELOG.md 中没有找到当前版本 ' + currentVersion);
    console.error('📝 请运行以下命令更新 changelog：');
    console.error('   npm run release        # patch 版本');
    console.error('   npm run release:minor  # minor 版本');
    console.error('   npm run release:major  # major 版本');
    console.error('');
    process.exit(1);
  } else {
    console.log('✓ CHANGELOG.md 已包含版本 ' + currentVersion);
    process.exit(0);
  }
} catch (error) {
  console.error('检查 changelog 时出错：', error.message);
  process.exit(1);
}