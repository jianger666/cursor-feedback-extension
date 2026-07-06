#!/usr/bin/env node
/**
 * 重复投递（duplicate delivery）的 smoke 回归：
 *  A. 同 wire id 重投（in-flight）：join 原等待，不发新卡、不 SUPERSEDE；面板提交后两次投递都拿到反馈
 *  B. 换 wire id 重投（内容启发式）：同窗口+同 summary+同 timeout → join；一次提交广播给两个 waiter
 *  C. 迟到重投（原请求已超时结束）：同 wire id 精确重放当时的超时结果，不开幽灵新轮
 *  D. 真正的新一轮（不同 summary）：仍按设计 SUPERSEDE 旧等待
 *
 * 背景：Cursor 客户端会把 in-flight 的 tool call 原样重投（实测可晚至 3~8 分钟），
 * 旧实现只在 90s 窗口内识别重复，超窗被误当新一轮 → 原调用收到 SUPERSEDED 提前收尾、
 * 重投开出的幽灵卡片没人认领。改动去重 / supersede / 重放相关代码后跑这个脚本回归。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const SMOKE_HOME = '/tmp/cf-smoke-dup-home';
const SERVER = path.join(__dirname, '..', 'dist', 'mcp-server.js');
const WS = '/tmp/smoke-dup-proj';

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
  // 隔离 HOME + 剔除 MCP_FEEDBACK_TIMEOUT（用户环境若设了会覆盖工具参数，C 场景要用 2s 短超时）
  const env = { ...process.env, MCP_FEEDBACK_IDLE_TIMEOUT: '120000', HOME: SMOKE_HOME, USERPROFILE: SMOKE_HOME };
  delete env.MCP_FEEDBACK_TIMEOUT;
  const child = spawn('node', [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { child, stderr: '', port: null, alive: true, responses: {} };
  child.stderr.on('data', (c) => {
    state.stderr += c.toString();
    const m = state.stderr.match(/HTTP Server listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) state.port = Number(m[1]);
  });
  // stdout 承载 MCP JSON-RPC 响应；同 id 的多次响应按到达顺序归档成数组
  let outBuf = '';
  child.stdout.on('data', (c) => {
    outBuf += c.toString();
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx).trim();
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          (state.responses[msg.id] ||= []).push(msg);
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  });
  child.on('exit', () => { state.alive = false; });
  return state;
}

function mcpSend(state, obj) {
  state.child.stdin.write(JSON.stringify(obj) + '\n');
}

function mcpInit(state) {
  mcpSend(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-dup', version: '1.0' } } });
  mcpSend(state, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

function callFeedback(state, id, summary, timeout) {
  mcpSend(state, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'interactive_feedback', arguments: { project_directory: WS, summary, timeout } } });
}

/** 等 responses[id] 攒够 count 条（带超时） */
async function waitResponses(state, id, count, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((state.responses[id] || []).length >= count) return state.responses[id];
    await sleep(100);
  }
  return state.responses[id] || [];
}

function resultText(resp) {
  try {
    return resp.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  } catch {
    return '';
  }
}

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `  -- ${detail}`}`);
  if (!cond) failures++;
}

async function snapshot(port) {
  const raw = await httpGet(port, `/api/feedback/current?workspace=${encodeURIComponent(WS)}`);
  return JSON.parse(raw);
}

async function submit(port, requestId, text) {
  return JSON.parse(await httpPost(port, '/api/feedback/submit', {
    requestId,
    feedback: { interactive_feedback: text, images: [], attachedFiles: [], project_directory: WS },
  }));
}

async function main() {
  fs.rmSync(SMOKE_HOME, { recursive: true, force: true });
  const s = startServer();
  await sleep(1500);
  check('server 启动并监听 HTTP', !!s.port, s.stderr.slice(-300));
  if (!s.port) process.exit(1);
  mcpInit(s);
  await sleep(300);

  // A. 同 wire id 重投（in-flight）→ join，不 SUPERSEDE、不开新卡
  callFeedback(s, 10, '去重A', 60);
  await sleep(800);
  let snap = await snapshot(s.port);
  check('A: 首次投递注册了等待', !!snap.request && snap.request.summary === '去重A', JSON.stringify(snap.request));
  const reqA = snap.request.id;
  callFeedback(s, 10, '去重A', 60); // 原样重投（同 JSON-RPC id）
  await sleep(600);
  check('A: 识别为 wire id 重复投递', s.stderr.includes('Duplicate delivery detected (matched by wire id)'), s.stderr.slice(-400));
  snap = await snapshot(s.port);
  check('A: 重投未开新卡（requestId 不变）', !!snap.request && snap.request.id === reqA, JSON.stringify(snap.request));
  check('A: 原调用没有被 SUPERSEDE', !s.stderr.includes('superseded by a newer request'));
  const sub1 = await submit(s.port, reqA, '回复A');
  check('A: 面板提交成功', sub1.success === true, JSON.stringify(sub1));
  const respsA = await waitResponses(s, 10, 2, 5000);
  check('A: 两次投递都拿到同一份反馈', respsA.length >= 2 && respsA.every((r) => resultText(r).includes('回复A')), `count=${respsA.length}`);

  // B. 换 wire id 重投 → 内容启发式 join（无时间窗；旧实现 90s 窗口被实测击穿的场景）
  callFeedback(s, 20, '去重B', 61);
  await sleep(600);
  snap = await snapshot(s.port);
  const reqB = snap.request && snap.request.id;
  check('B: 首次投递注册了等待', !!reqB, JSON.stringify(snap.request));
  callFeedback(s, 21, '去重B', 61); // 客户端重投但换了新 JSON-RPC id
  await sleep(600);
  check('B: 识别为内容重复投递', s.stderr.includes('Duplicate delivery detected (matched by content)'), s.stderr.slice(-400));
  snap = await snapshot(s.port);
  check('B: 重投未开新卡（requestId 不变）', !!snap.request && snap.request.id === reqB, JSON.stringify(snap.request));
  await submit(s.port, reqB, '回复B');
  const respB1 = await waitResponses(s, 20, 1, 5000);
  const respB2 = await waitResponses(s, 21, 1, 5000);
  check('B: 一次提交广播给两个 waiter', respB1.length >= 1 && respB2.length >= 1 && resultText(respB1[0]).includes('回复B') && resultText(respB2[0]).includes('回复B'));

  // C. 迟到重投（原请求已超时结束）→ 按 wire id 重放结果，不开幽灵新轮
  callFeedback(s, 30, '重放C', 2);
  const respC1 = await waitResponses(s, 30, 1, 8000);
  check('C: 首次投递等到超时续期', respC1.length >= 1 && resultText(respC1[0]).includes('[TIMEOUT_KEEP_WAITING]'), resultText(respC1[0] || {}).slice(0, 80));
  callFeedback(s, 30, '重放C', 2); // 原请求结束后才迟到的重投
  const respC2 = await waitResponses(s, 30, 2, 3000);
  check('C: 迟到重投立即重放超时结果', respC2.length >= 2 && resultText(respC2[1]).includes('[TIMEOUT_KEEP_WAITING]'), `count=${respC2.length}`);
  check('C: 日志确认走了重放路径', s.stderr.includes('replaying its outcome'), s.stderr.slice(-400));
  snap = await snapshot(s.port);
  check('C: 没有幽灵新轮（无等待中的请求）', !snap.request, JSON.stringify(snap.request));

  // D. 真正的新一轮（不同 summary）→ 仍按设计 SUPERSEDE 旧等待
  callFeedback(s, 40, '新一轮D1', 60);
  await sleep(500);
  callFeedback(s, 41, '新一轮D2', 60);
  const respD1 = await waitResponses(s, 40, 1, 5000);
  check('D: 旧等待被新一轮取代（SUPERSEDED）', respD1.length >= 1 && resultText(respD1[0]).includes('[SUPERSEDED]'), resultText(respD1[0] || {}).slice(0, 80));
  snap = await snapshot(s.port);
  check('D: 新一轮成为当前等待', !!snap.request && snap.request.summary === '新一轮D2', JSON.stringify(snap.request));
  await submit(s.port, snap.request.id, '收尾D');
  await waitResponses(s, 41, 1, 5000);

  s.child.kill('SIGKILL');
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
