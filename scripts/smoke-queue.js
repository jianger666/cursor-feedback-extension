#!/usr/bin/env node
/**
 * 忙时队列的 smoke 回归（npm run test:smoke）：
 *  A. 面板入队：POST /api/feedback/enqueue 依次入队 2 条 → 轮询快照按序返回（source=panel，带唯一 id）
 *  B. 撤回：再入队 1 条后按 id 撤回 → 快照回到 2 条；伪造 id 撤回返回 removed:false
 *  C. 队列兑现：interactive_feedback 注册即消费 → 返回 [QUEUED_MESSAGES] 且两条按序、快照清空
 *  D. pending 互斥：有等待中的请求时 enqueue 返回 queued:false/pending；面板正常提交能兑现该请求
 *  E. 版本号：/api/health 的 version 与 package.json 一致（不再是硬编码）
 *
 * 改动队列 / 路由 / 状态机相关代码后跑这个脚本做快速回归。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const SMOKE_HOME = '/tmp/cf-smoke-home';
const SERVER = path.join(__dirname, '..', 'dist', 'mcp-server.js');
const PKG_VERSION = require(path.join(__dirname, '..', 'package.json')).version;
const WS = '/tmp/smoke-queue-proj';

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
    env: {
      ...process.env,
      MCP_FEEDBACK_IDLE_TIMEOUT: '120000',
      // 隔离 HOME：不读用户真实的 ~/.cursor-feedback 配置（如忙时排队开关可能被关掉）
      HOME: SMOKE_HOME,
      USERPROFILE: SMOKE_HOME,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { child, stderr: '', port: null, alive: true, responses: {} };
  child.stderr.on('data', (c) => {
    state.stderr += c.toString();
    const m = state.stderr.match(/HTTP Server listening on http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) state.port = Number(m[1]);
  });
  // stdout 承载 MCP JSON-RPC 响应（按行分隔），按 id 归档供断言
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
        if (msg.id !== undefined) state.responses[msg.id] = msg;
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
  mcpSend(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } });
  mcpSend(state, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

function callFeedback(state, id, summary, timeout) {
  mcpSend(state, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'interactive_feedback', arguments: { project_directory: WS, summary, timeout } } });
}

/** 等 responses[id] 出现（带超时） */
async function waitResponse(state, id, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state.responses[id]) return state.responses[id];
    await sleep(100);
  }
  return null;
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

async function main() {
  // 清掉上次残留的隔离 HOME（失败中断可能留下 queueWhenBusy=false 等状态）
  fs.rmSync(SMOKE_HOME, { recursive: true, force: true });
  const s = startServer();
  await sleep(1500);
  check('server 启动并监听 HTTP', !!s.port, s.stderr.slice(-300));
  if (!s.port) process.exit(1);
  mcpInit(s);
  await sleep(300);

  // E. 版本号来自 package.json
  const health = JSON.parse(await httpGet(s.port, '/api/health'));
  check('E: /api/health 版本与 package.json 一致', health.version === PKG_VERSION, `got=${health.version} want=${PKG_VERSION}`);

  // A. 面板依次入队 2 条
  const q1 = JSON.parse(await httpPost(s.port, '/api/feedback/enqueue', { text: '第一条排队', projectDir: WS }));
  const q2 = JSON.parse(await httpPost(s.port, '/api/feedback/enqueue', { text: '第二条排队', projectDir: WS }));
  check('A: 两条面板消息均入队成功', q1.queued === true && q2.queued === true);
  let snap = await snapshot(s.port);
  check('A: 快照返回 2 条且按序', Array.isArray(snap.queued) && snap.queued.length === 2 && snap.queued[0].text === '第一条排队' && snap.queued[1].text === '第二条排队', JSON.stringify(snap.queued));
  check('A: 队列项带唯一 id 且 source=panel', snap.queued.length === 2 && snap.queued.every((x) => typeof x.id === 'string' && x.id && x.source === 'panel') && snap.queued[0].id !== snap.queued[1].id);

  // B. 撤回第三条；伪造 id 撤回失败
  await httpPost(s.port, '/api/feedback/enqueue', { text: '要撤回的一条', projectDir: WS });
  snap = await snapshot(s.port);
  const victim = snap.queued.find((x) => x.text === '要撤回的一条');
  const rm = JSON.parse(await httpPost(s.port, '/api/feedback/queue/remove', { id: victim.id }));
  check('B: 按 id 撤回成功', rm.removed === true);
  snap = await snapshot(s.port);
  check('B: 撤回后快照回到 2 条', snap.queued.length === 2 && !snap.queued.some((x) => x.text === '要撤回的一条'), JSON.stringify(snap.queued));
  const rmBogus = JSON.parse(await httpPost(s.port, '/api/feedback/queue/remove', { id: 'q_bogus' }));
  check('B: 伪造 id 撤回返回 removed:false', rmBogus.removed === false);

  // B2. 全局排队开关关闭时 enqueue 被拒（面板 UI 已隐藏入口，这是服务端兜底）
  await httpPost(s.port, '/api/feishu/config', { appId: '', appSecret: '', enabled: true, ackReaction: true, queueWhenBusy: false });
  const qDisabled = JSON.parse(await httpPost(s.port, '/api/feedback/enqueue', { text: '开关关了', projectDir: WS }));
  check('B2: 排队开关关闭时 enqueue 返回 disabled', qDisabled.queued === false && qDisabled.reason === 'disabled', JSON.stringify(qDisabled));
  await httpPost(s.port, '/api/feishu/config', { appId: '', appSecret: '', enabled: true, ackReaction: true, queueWhenBusy: true });

  // C. interactive_feedback 注册即消费队列
  callFeedback(s, 2, '摘要（应被队列即时兑现）', 60);
  const resp2 = await waitResponse(s, 2, 5000);
  const text2 = resp2 ? resultText(resp2) : '';
  check('C: 调用立即返回 [QUEUED_MESSAGES]', text2.includes('[QUEUED_MESSAGES]'), text2.slice(0, 120));
  check('C: 两条排队消息按序在正文中', text2.indexOf('第一条排队') > 0 && text2.indexOf('第一条排队') < text2.indexOf('第二条排队'));
  snap = await snapshot(s.port);
  check('C: 消费后快照清空', Array.isArray(snap.queued) && snap.queued.length === 0, JSON.stringify(snap.queued));

  // D. 有 pending 时 enqueue 拒绝；面板提交正常兑现
  callFeedback(s, 3, '第二轮摘要（等面板提交）', 60);
  await sleep(500);
  snap = await snapshot(s.port);
  check('D: 轮询能看到等待中的请求', !!snap.request && snap.request.summary === '第二轮摘要（等面板提交）');
  const qPending = JSON.parse(await httpPost(s.port, '/api/feedback/enqueue', { text: '不该排队', projectDir: WS }));
  check('D: pending 期间 enqueue 返回 queued:false/pending', qPending.queued === false && qPending.reason === 'pending', JSON.stringify(qPending));
  const submit = JSON.parse(await httpPost(s.port, '/api/feedback/submit', {
    requestId: snap.request.id,
    feedback: { interactive_feedback: '面板直接提交的反馈', images: [], attachedFiles: [], project_directory: WS },
  }));
  check('D: 面板提交成功', submit.success === true, JSON.stringify(submit));
  const resp3 = await waitResponse(s, 3, 5000);
  const text3 = resp3 ? resultText(resp3) : '';
  check('D: 工具返回面板提交的反馈内容', text3.includes('面板直接提交的反馈'), text3.slice(0, 120));

  s.child.kill('SIGKILL');
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
