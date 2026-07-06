#!/usr/bin/env node
/**
 * CliLauncher 冒烟测试：不碰真实环境（HOME 重定向到临时目录），用假的 cursor-agent
 * 验证 —— cli-config.json 强制写 maxMode=false、prompt 注入（协议 + 用户规则 + 任务）、
 * 会话结果回调、并发拒绝、/stop 终止。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HOME 重定向必须在 require 之前生效（os.homedir() 在 POSIX 上优先读 process.env.HOME）
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-launcher-smoke-'));
process.env.HOME = tmpHome;

const { CliLauncher } = require('../dist/cli-launcher.js');

let failed = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failed++;
  }
}

function writeFakeAgent(script) {
  const p = path.join(tmpHome, 'fake-cursor-agent.sh');
  fs.writeFileSync(p, '#!/bin/bash\n' + script);
  fs.chmodSync(p, 0o755);
  process.env.CURSOR_AGENT_PATH = p;
  return p;
}

async function main() {
  // 预置：残留的 cli-config.json 是 maxMode=true（模拟交互式会话改回 max 的现场）
  fs.mkdirSync(path.join(tmpHome, '.cursor'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, '.cursor', 'cli-config.json'),
    JSON.stringify({ maxMode: true, model: { modelId: 'x', maxMode: true }, keepMe: 42 }),
  );
  // 预置：用户自定义注入规则
  fs.mkdirSync(path.join(tmpHome, '.cursor-feedback'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.cursor-feedback', 'cli-rules.md'), '永远不要启动Subagent');

  console.log('A. 正常会话：config 重写 + prompt 注入 + 结果回调');
  {
    // 假 agent：把收到的参数逐行打出，便于断言 prompt 内容
    writeFakeAgent('for a in "$@"; do echo "ARG::$a"; done');
    const launcher = new CliLauncher();
    const result = await new Promise((resolve) => {
      const err = launcher.start('帮我修个bug', tmpHome, resolve);
      check('start 返回 null（无启动错误）', err === null);
      check('isRunning 为 true', launcher.isRunning());
    });
    check('退出码 0', result.code === 0);
    check('结束后 isRunning 为 false', !launcher.isRunning());
    check('非 stopped / 非 timedOut', !result.stopped && !result.timedOut);
    check('参数含 -p 非交互', result.output.includes('ARG::-p'));
    check('参数含 --trust', result.output.includes('ARG::--trust'));
    check('参数含 --model claude-fable-5-thinking-max',
      result.output.includes('ARG::claude-fable-5-thinking-max'));
    check('prompt 注入沟通协议', result.output.includes('interactive_feedback'));
    check('prompt 注入用户规则', result.output.includes('永远不要启动Subagent'));
    check('prompt 注入任务本体', result.output.includes('帮我修个bug'));

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpHome, '.cursor', 'cli-config.json'), 'utf-8'));
    check('cli-config 顶层 maxMode=false', cfg.maxMode === false);
    check('cli-config model.maxMode=false', cfg.model && cfg.model.maxMode === false);
    check('cli-config model.modelId 正确', cfg.model && cfg.model.modelId === 'claude-fable-5-thinking-max');
    check('cli-config 其他字段保留', cfg.keepMe === 42);
  }

  console.log('B. 并发拒绝 + /stop 终止');
  {
    writeFakeAgent('sleep 60');
    const launcher = new CliLauncher();
    const done = new Promise((resolve) => {
      const err = launcher.start('长任务', tmpHome, resolve);
      check('长任务启动成功', err === null);
    });
    await new Promise((r) => setTimeout(r, 300));
    const err2 = launcher.start('第二个任务', tmpHome, () => {});
    check('运行中拒绝并发 start', typeof err2 === 'string' && err2.includes('已有'));
    check('describe 含任务摘要', launcher.describe().includes('长任务'));
    check('stop 返回 true', launcher.stop() === true);
    const result = await done;
    check('stopped 标记为 true', result.stopped === true);
    check('结束后可再次拉起（isRunning false）', !launcher.isRunning());
    check('空闲时 stop 返回 false', launcher.stop() === false);
  }

  console.log('C. 二进制不存在 → 走 error 收尾而不是抛异常');
  {
    process.env.CURSOR_AGENT_PATH = path.join(tmpHome, 'no-such-binary');
    const launcher = new CliLauncher();
    const result = await new Promise((resolve) => {
      const err = launcher.start('任务', tmpHome, resolve);
      // CURSOR_AGENT_PATH 不存在时回退 ~/.local/bin 或 PATH，spawn error 异步走 onDone
      check('start 未同步抛错', err === null || typeof err === 'string');
      if (err !== null) resolve({ code: null, output: '', errorOutput: err, stopped: false, timedOut: false, elapsedMs: 0 });
    });
    check('失败会话有错误信息', result.code !== 0 && (result.errorOutput.length > 0 || result.code === null));
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
