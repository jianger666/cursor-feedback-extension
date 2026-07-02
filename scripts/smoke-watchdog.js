#!/usr/bin/env node
/**
 * Watchdog 修复的 smoke 验证（一次性脚本，验证后可删）：
 *  A. 子目录心跳：project_directory 是窗口工作区的子目录时，心跳应命中（前缀互含）
 *  B. owner 锁定：owner 被真实窗口心跳确认后，后续调用传不同 project_directory 不改写 owner，不被误杀
 *  C. pending 保护：心跳停止（模拟窗口卡死）+ 有 pending 时绝不自杀；pending 清空后恢复僵尸判定并退出
 *  D. stop 防重入：stdin 关闭时 "Stopping server..." 只出现一次，无栈溢出
 *
 * 用 MCP_FEEDBACK_IDLE_TIMEOUT=8000 加速（生产默认 30000）。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'dist', 'mcp-server.js');
const IDLE = 8000;
const WS = '/tmp/smoke-proj-a';        // 模拟窗口工作区（插件心跳带的路径）
const SUBDIR = WS + '/packages/web';   // AI 传的子目录
const OTHER = '/tmp/smoke-proj-b';     // AI 传的无关目录

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

function httpPost(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function startServer() {
  const child = spawn('node', [SERVER], {
    env: { ...process.env, MCP_FEEDBACK_IDLE_TIMEOUT: String(IDLE), MCP_FEEDBACK_TIMEOUT: '120' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { child, stderr: '', port: null, alive: true, exitCode: null };
  child.stderr.on('data', (c) => {
    state.stderr += c.toString();
    const m = state.stderr.match(/HTTP Server listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) state.port = Number(m[1]);
  });
  child.stdout.on('data', () => {});
  child.on('exit', (code) => {
    state.alive = false;
    state.exitCode = code;
  });
  return state;
}

function mcpSend(state, obj) {
  state.child.stdin.write(JSON.stringify(obj) + '\n');
}

function mcpInit(state) {
  mcpSend(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } });
  mcpSend(state, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  -- ${detail}`}`);
  if (!cond) failures++;
}

async function main() {
  console.log('=== 实例 1：场景 A + B + C ===');
  const s1 = startServer();
  await sleep(1500);
  check('server 启动并监听 HTTP', !!s1.port, s1.stderr.slice(-300));
  mcpInit(s1);
  await sleep(300);

  // 模拟插件心跳：每秒带真实工作区 WS 轮询
  let heartbeatOn = true;
  const hb = setInterval(() => {
    if (heartbeatOn && s1.port) httpGet(s1.port, `/api/feedback/current?workspace=${encodeURIComponent(WS)}`).catch(() => {});
  }, 1000);

  // 场景 A：调用传子目录 → 心跳（父目录）应能确认 owner
  mcpSend(s1, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'interactive_feedback', arguments: { project_directory: SUBDIR, summary: 'A', timeout: 120 } } });
  await sleep(3000);
  check('A: 子目录 owner 被父目录心跳确认（无 stale 迹象）', s1.alive && !s1.stderr.includes('stale instance'));

  // 场景 B：第二次调用传无关目录 → owner 不被改写；等超过 IDLE 仍存活
  mcpSend(s1, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'interactive_feedback', arguments: { project_directory: OTHER, summary: 'B', timeout: 120 } } });
  await sleep(IDLE + 5000);
  check('B: 传不同 project_directory 后 owner 保持不改写', s1.stderr.includes('Owner workspace kept as'));
  check('B: 超过 IDLE_TIMEOUT 后进程仍存活（修复前此处自杀）', s1.alive && !s1.stderr.includes('stale instance'), `alive=${s1.alive}`);

  // 场景 C：停心跳（模拟窗口无响应），pending 仍在 → 不自杀
  heartbeatOn = false;
  await sleep(IDLE + 6000);
  check('C: 心跳停止但有 pending 时不自杀', s1.alive && !s1.stderr.includes('stale instance'), `alive=${s1.alive}`);

  // resolve 全部 pending（两次调用的 projectDir 不同，第二次不会作废第一次的 pending，
  // 这正是防「多 agent 取消风暴」的既有设计）→ 无 pending + 心跳停 → 防线 3 应正常杀掉真僵尸
  const reqIds = [...new Set([...s1.stderr.matchAll(/Feedback request created: (req_\S+)/g)].map((m) => m[1]))];
  check('C: 能读到 pending 请求 id', reqIds.length === 2, `ids=${reqIds.length}`);
  for (const reqId of reqIds) {
    await httpPost(s1.port, '/api/feedback/submit', { requestId: reqId, feedback: { interactive_feedback: 'done', images: [], attachedFiles: [], project_directory: OTHER } });
  }
  await sleep(IDLE + 7000);
  check('C: pending 清空后僵尸判定恢复、进程自杀退出', !s1.alive && s1.stderr.includes('stale instance'), `alive=${s1.alive}`);
  const stops1 = (s1.stderr.match(/Stopping server\.\.\./g) || []).length;
  check('D(附带): 自杀路径 Stopping server 只出现一次', stops1 === 1, `count=${stops1}`);
  check('D(附带): 无栈溢出', !s1.stderr.includes('Maximum call stack'));
  clearInterval(hb);
  if (s1.alive) s1.child.kill('SIGKILL');

  console.log('=== 实例 2：场景 D（stdin 关闭的 stop 防重入）===');
  const s2 = startServer();
  await sleep(1500);
  mcpInit(s2);
  await sleep(300);
  s2.child.stdin.end();
  await sleep(2500);
  const stops2 = (s2.stderr.match(/Stopping server\.\.\./g) || []).length;
  check('D: stdin 关闭后进程退出', !s2.alive, `alive=${s2.alive}`);
  check('D: Stopping server 只出现一次（修复前刷屏数万条）', stops2 === 1, `count=${stops2}`);
  check('D: 无 Maximum call stack size exceeded', !s2.stderr.includes('Maximum call stack'));
  if (s2.alive) s2.child.kill('SIGKILL');

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
