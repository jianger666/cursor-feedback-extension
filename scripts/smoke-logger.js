#!/usr/bin/env node
/**
 * 落盘日志 + 诊断端点冒烟：HOME 重定向到临时目录，验证——
 * 日志写入当天文件、过期文件清理、readRecentLogs 截断、诊断端点脱敏。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-smoke-'));
process.env.HOME = tmpHome;

const { fileLog, readRecentLogs } = require('../dist/logger.js');

let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function main() {
  const logsDir = path.join(tmpHome, '.cursor-feedback', 'logs');

  console.log('A. 日志写入 + 过期清理');
  {
    // 预埋一个过期日志（10 天前）和一个不该被碰的无关文件
    fs.mkdirSync(logsDir, { recursive: true });
    const old = new Date();
    old.setDate(old.getDate() - 10);
    fs.writeFileSync(path.join(logsDir, `${localDay(old)}.log`), 'stale\n');
    fs.writeFileSync(path.join(logsDir, 'keep.txt'), 'not-a-log\n');

    fileLog('mcp', 'hello world');
    fileLog('feishu', '第二条');

    const todayFile = path.join(logsDir, `${localDay()}.log`);
    check('当天日志文件已创建', fs.existsSync(todayFile));
    const content = fs.readFileSync(todayFile, 'utf-8');
    check('日志含 tag 与内容', content.includes('[mcp] hello world') && content.includes('[feishu] 第二条'));
    check('每行带 ISO 时间戳', /^\[\d{4}-\d{2}-\d{2}T/.test(content));
    check('过期日志已被清理', !fs.existsSync(path.join(logsDir, `${localDay(old)}.log`)));
    check('无关文件不被误删', fs.existsSync(path.join(logsDir, 'keep.txt')));
  }

  console.log('B. readRecentLogs 读取与截断');
  {
    const text = readRecentLogs();
    check('能读到刚写的日志', text.includes('hello world'));
    const tiny = readRecentLogs(50);
    check('超限时从尾部截断', tiny.length <= 50 + 20 && tiny.includes('截断'));
  }

  console.log('C. 诊断报告脱敏（/api/diagnostics 端点，子进程 --daemon 模式验证）');
  {
    // 预埋含密钥的飞书配置
    fs.writeFileSync(
      path.join(tmpHome, '.cursor-feedback', 'feishu-config.json'),
      JSON.stringify({ appId: 'cli_a1b2c3d4e5f6', appSecret: 'SUPER_SECRET_VALUE', enabled: true }),
    );
    const { spawn } = require('child_process');
    const repoRoot = path.join(__dirname, '..');
    const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'mcp-server.js'), '--daemon'], {
      env: { ...process.env, HOME: tmpHome, CURSOR_FEEDBACK_KEEP_AWAKE: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));
    let port = null;
    for (let i = 0; i < 50 && !port; i++) {
      const m = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) port = parseInt(m[1], 10);
      else await new Promise((r) => setTimeout(r, 200));
    }
    check('server 已就绪', port !== null);
    let body = '';
    if (port) {
      body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/diagnostics`, (res) => {
          let s = '';
          res.on('data', (c) => (s += c));
          res.on('end', () => resolve(s));
        }).on('error', reject);
      });
    }
    check('报告含版本与环境区块', body.includes('===== 环境 =====') && body.includes('version:'));
    check('appSecret 绝不出现', !body.includes('SUPER_SECRET_VALUE'));
    check('appId 已脱敏（只留前 8 位）', body.includes('cli_a1b2***') && !body.includes('cli_a1b2c3d4e5f6'));
    check('报告含最近日志区块', body.includes('hello world'));
    check('报告含常驻服务状态区块', body.includes('===== 常驻服务状态 ====='));
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
  }

  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\n${failed} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部通过 ✅');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
