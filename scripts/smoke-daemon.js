#!/usr/bin/env node
/**
 * 常驻守护冒烟测试（不碰真实环境）：
 * A. --daemon 模式启动：stdin 为 /dev/null 时不自杀、HTTP 可用、daemon/status 端点正常
 * B. installDaemon/uninstallDaemon：包拷贝 + plist 生成 + 状态查询（PATH 置空防止真的注册 launchd）
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const repoRoot = path.join(__dirname, '..');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-smoke-'));

let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('A. --daemon 模式启动');
  {
    const child = spawn(process.execPath, [path.join(repoRoot, 'dist', 'mcp-server.js'), '--daemon'], {
      env: { ...process.env, HOME: tmpHome, CURSOR_FEEDBACK_KEEP_AWAKE: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'], // stdin=/dev/null，模拟 launchd 拉起
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c.toString()));

    // 等 HTTP server 就绪并解析实际端口（基准口可能被真实实例占用，会顺延）
    let port = null;
    for (let i = 0; i < 50 && !port; i++) {
      const m = stderr.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) port = parseInt(m[1], 10);
      else await sleep(200);
    }
    check('HTTP server 已就绪', port !== null);
    check('日志声明 daemon 模式', /Daemon mode started/.test(stderr));

    // stdin 是 /dev/null：等 3s 确认没有因 stdin close 自杀
    await sleep(3000);
    check('3s 后进程仍存活（无 stdin 自杀）', child.exitCode === null);

    if (port) {
      const status = JSON.parse(await httpGet(port, '/api/daemon/status'));
      check('daemon/status 返回 supported', status.supported === true);
      check('daemon/status 未安装', status.installed === false);
      check('daemon/status 带当前版本', typeof status.currentVersion === 'string');
    }

    // SIGTERM 正常退出
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    check('SIGTERM 后进程退出', true);
  }

  console.log('B. installDaemon / uninstallDaemon（PATH 置空，不真注册 launchd）');
  {
    // 子进程跑安装：HOME 指向临时目录、PATH 置空目录 → launchctl/schtasks 调不到（被容错跳过）
    const emptyBin = path.join(tmpHome, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });
    const run = (expr) =>
      execFileSync(process.execPath, ['-e', expr], {
        env: { HOME: tmpHome, PATH: emptyBin },
        cwd: repoRoot,
        encoding: 'utf-8',
      });

    const out = run(
      `const d = require('${repoRoot}/dist/daemon-install.js');` +
      `process.stdout.write(JSON.stringify(d.installDaemon()));`,
    );
    const st = JSON.parse(out);
    check('install 后状态 installed=true', st.installed === true);
    check('install 记录版本号', /^\d+\.\d+\.\d+/.test(st.installedVersion || ''));

    const appDir = path.join(tmpHome, '.cursor-feedback', 'daemon', 'app');
    check('包已拷贝（dist/mcp-server.js 存在）', fs.existsSync(path.join(appDir, 'dist', 'mcp-server.js')));
    check('依赖已拷贝（@larksuiteoapi 存在）',
      fs.existsSync(path.join(appDir, 'node_modules', '@larksuiteoapi')));
    check('依赖已拷贝（@modelcontextprotocol 存在）',
      fs.existsSync(path.join(appDir, 'node_modules', '@modelcontextprotocol')));
    check('未套娃拷贝自身', !fs.existsSync(path.join(appDir, 'node_modules', 'cursor-feedback')));

    if (process.platform === 'darwin') {
      const plist = path.join(tmpHome, 'Library', 'LaunchAgents', 'com.jianger666.cursor-feedback.daemon.plist');
      check('plist 已写入', fs.existsSync(plist));
      const content = fs.readFileSync(plist, 'utf-8');
      check('plist 指向拷贝目录入口', content.includes(path.join(appDir, 'dist', 'mcp-server.js')));
      check('plist 带 --daemon 参数', content.includes('<string>--daemon</string>'));
      check('plist RunAtLoad + KeepAlive', content.includes('<key>RunAtLoad</key>') && content.includes('<key>KeepAlive</key>'));
    }

    // 拷贝出的 app 必须能独立启动（依赖完整性的最终证明）
    {
      const child = spawn(process.execPath, [path.join(appDir, 'dist', 'mcp-server.js'), '--daemon'], {
        env: { ...process.env, HOME: tmpHome, CURSOR_FEEDBACK_KEEP_AWAKE: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += c.toString()));
      let ok = false;
      for (let i = 0; i < 50 && !ok; i++) {
        if (/Daemon mode started/.test(stderr)) ok = true;
        else await sleep(200);
      }
      check('拷贝出的 app 可独立启动 daemon', ok);
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }

    const out2 = run(
      `const d = require('${repoRoot}/dist/daemon-install.js');` +
      `process.stdout.write(JSON.stringify(d.uninstallDaemon()));`,
    );
    const st2 = JSON.parse(out2);
    check('uninstall 后状态 installed=false', st2.installed === false);
    check('拷贝目录已清理', !fs.existsSync(appDir));
    if (process.platform === 'darwin') {
      check('plist 已删除', !fs.existsSync(path.join(tmpHome, 'Library', 'LaunchAgents', 'com.jianger666.cursor-feedback.daemon.plist')));
    }
  }

  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`\n${failed} 项断言失败`);
    process.exit(1);
  }
  console.log('\n全部通过 ✅');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
