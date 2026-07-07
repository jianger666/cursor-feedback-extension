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
  fs.mkdirSync(path.join(tmpHome, '.cursor'), { recursive: true });
  // 预置：mcp.json 里混着 boolean/number env（实测会让 CLI 静默忽略整个文件）
  fs.writeFileSync(
    path.join(tmpHome, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { 'cursor-feedback': {
      command: 'npx', args: ['-y', 'cursor-feedback@latest'],
      env: { FEISHU_ENABLED: true, FEISHU_APP_ID: 'cli_x', RETRIES: 3 },
    } } }),
  );
  // 预置：用户自定义注入规则
  fs.mkdirSync(path.join(tmpHome, '.cursor-feedback'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.cursor-feedback', 'cli-rules.md'), '永远不要启动Subagent');

  console.log('A. 正常会话：prompt 注入 + 结果回调');
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
    check('参数含 --approve-mcps（headless 必须自动批准 MCP）', result.output.includes('ARG::--approve-mcps'));
    check('参数含 --force（否则 MCP 工具调用被静默拒绝，agent 发不出卡片）', result.output.includes('ARG::--force'));
    check('参数含 --model 默认模型',
      result.output.includes('ARG::claude-fable-5-thinking-xhigh'));
    check('prompt 注入沟通协议', result.output.includes('interactive_feedback'));
    check('prompt 注入用户规则', result.output.includes('永远不要启动Subagent'));
    check('prompt 注入任务本体', result.output.includes('帮我修个bug'));

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpHome, '.cursor', 'mcp.json'), 'utf-8'));
    const env = mcp.mcpServers['cursor-feedback'].env;
    check('mcp.json boolean env 已归一化为字符串', env.FEISHU_ENABLED === 'true');
    check('mcp.json number env 已归一化为字符串', env.RETRIES === '3');
    check('mcp.json 原有字符串 env 不变', env.FEISHU_APP_ID === 'cli_x');
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

  console.log('B2. 多实例全局锁：并发拒绝 + 跨实例 /stop + 死锁自清');
  {
    // 模拟两个窗口/守护实例：两个 launcher 对象共享磁盘锁文件
    writeFakeAgent('sleep 60');
    const a = new CliLauncher();
    const b = new CliLauncher();
    const doneA = new Promise((resolve) => {
      const err = a.start('实例A的长任务', tmpHome, resolve);
      check('实例A启动成功', err === null);
    });
    await new Promise((r) => setTimeout(r, 300));
    check('实例B全局视角 isRunning=true', b.isRunning() === true);
    const errB = b.start('实例B的任务', tmpHome, () => {});
    check('实例B start 被全局锁拒绝', typeof errB === 'string' && errB.includes('已有'));
    check('实例B describe 能看到 A 的任务', b.describe().includes('实例A的长任务'));
    check('实例B 跨实例 stop 返回 true', b.stop() === true);
    const resultA = await doneA;
    check('A 的会话被 B 终止且标记 stopped', resultA.stopped === true);
    check('锁已释放（B 视角 isRunning=false）', b.isRunning() === false);

    // 死锁自清：伪造一个持锁进程已死的残锁
    const lockPath = path.join(tmpHome, '.cursor-feedback', 'cli-session.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, task: '幽灵', startedAt: Date.now(), ownerPid: 999998 }));
    check('残锁（进程已死）不算运行中', b.isRunning() === false);
    check('残锁已被自动清除', !fs.existsSync(lockPath));
    writeFakeAgent('echo ok');
    const resultC = await new Promise((resolve) => {
      const err = b.start('残锁后的新任务', tmpHome, resolve);
      check('清残锁后可正常拉起', err === null);
    });
    check('新任务正常结束', resultC.code === 0);
  }

  console.log('B3. listProjects：读 IDE storage.json、去重、过滤已删除目录');
  {
    // 构造假的 Cursor storage.json（按当前平台的真实路径规则放在 tmpHome 下）
    const storageDir = process.platform === 'darwin'
      ? path.join(tmpHome, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(tmpHome, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage')
        : path.join(tmpHome, '.config', 'Cursor', 'User', 'globalStorage');
    fs.mkdirSync(storageDir, { recursive: true });
    const projA = path.join(tmpHome, 'proj-a');
    const projB = path.join(tmpHome, 'proj b'); // 含空格 → 验证 URI 解码
    fs.mkdirSync(projA);
    fs.mkdirSync(projB);
    const uri = (p) => 'file://' + p.split(path.sep).map(encodeURIComponent).join('/');
    fs.writeFileSync(path.join(storageDir, 'storage.json'), JSON.stringify({
      backupWorkspaces: { folders: [{ folderUri: uri(projB) }] },
      profileAssociations: { workspaces: {
        [uri(projA)]: 'x',
        [uri(projB)]: 'x', // 与 backup 重复 → 应去重
        [uri(path.join(tmpHome, 'deleted-proj'))]: 'x', // 不存在 → 应过滤
      } },
    }));
    const launcher = new CliLauncher();
    const projects = launcher.listProjects();
    check('返回 2 个项目（去重 + 过滤已删除）', projects.length === 2);
    check('最近打开的排在前面', projects[0] === projB);
    check('URI 编码路径被正确解码', projects.includes(projB) && projects.includes(projA));
  }

  console.log('C. 二进制不存在 → start 同步返回安装指引（不再走晦涩的 spawn error）');
  {
    process.env.CURSOR_AGENT_PATH = path.join(tmpHome, 'no-such-binary');
    const savedPath = process.env.PATH;
    process.env.PATH = tmpHome; // 清空 PATH，防止 which 命中真机的 cursor-agent
    const launcher = new CliLauncher();
    const err = launcher.start('任务', tmpHome, () => {});
    check('start 同步返回错误说明', typeof err === 'string' && err.length > 0);
    check('错误说明含安装指引', typeof err === 'string' && err.includes('cursor.com/install'));
    check('失败后未持锁（可重试）', !launcher.isRunning());
    process.env.PATH = savedPath;
  }

  console.log('B4. listModels：解析 --list-models 输出 + 缓存');
  {
    writeFakeAgent(
      'if [ "$1" = "--list-models" ]; then\n' +
      '  echo "Available models"\n  echo ""\n' +
      '  echo "auto - Auto"\n' +
      '  echo "claude-fable-5-thinking-xhigh - Fable 5 1M Extra High Thinking (NO ZDR)"\n' +
      '  echo "gpt-5.5-medium - GPT-5.5 1M"\n' +
      '  echo "Tip: use --model <id> to switch."\n' +
      'fi',
    );
    const launcher = new CliLauncher();
    const models = launcher.listModels();
    check('解析出 3 个模型', models.length === 3);
    check('id 与显示名正确', models.some((m) => m.id === 'claude-fable-5-thinking-xhigh' && m.name.includes('Fable 5')));
    check('Tip 行不被误解析', !models.some((m) => m.id === 'Tip:'));
    writeFakeAgent('echo "SHOULD NOT RUN"; exit 1'); // 换脚本后仍应命中缓存
    const cached = launcher.listModels();
    check('10 分钟内走缓存', cached.length === 3);
  }

  console.log('D. 收尾回调只触发一次（error 与 close 双事件防重）');
  {
    // 假 agent 是有效脚本但立即退出非 0：close 一定触发；再验证多次事件下 onDone 只回调一次
    writeFakeAgent('exit 7');
    const launcher = new CliLauncher();
    let doneCount = 0;
    const result = await new Promise((resolve) => {
      const err = launcher.start('任务', tmpHome, (r) => { doneCount++; resolve(r); });
      check('启动成功', err === null);
    });
    await new Promise((r) => setTimeout(r, 400));
    check('onDone 只回调一次', doneCount === 1);
    check('退出码正确传递', result.code === 7);
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
