/**
 * 常驻守护进程的安装 / 卸载 / 状态查询。
 *
 * 目标：Cursor（IDE）不开时飞书链路依然可用——server 以 standalone 守护方式开机自启。
 *
 * 安装策略：把「当前正在运行的这份包」（dist + package.json + 依赖 node_modules）
 * 完整复制到 ~/.cursor-feedback/daemon/app/，自启配置指向这份拷贝。
 * 为什么复制而不是原地引用：npx 缓存路径会被 npm 清理、扩展目录随版本升级变化，
 * 原地引用会让守护进程某天悄悄失联；拷贝是自包含的，升级时重装一次即可覆盖。
 *
 * 平台注册方式：
 * - macOS：~/Library/LaunchAgents/<label>.plist（launchd：开机自启 + 崩溃自动拉起）
 * - Windows：schtasks 登录触发计划任务（无需管理员），经 wscript + vbs 隐藏窗口启动
 */
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileLog } from './logger.js';

const LABEL = 'com.jianger666.cursor-feedback.daemon';
const WIN_TASK_NAME = 'CursorFeedbackDaemon';

function dlog(message: string) {
  console.error(`[${new Date().toISOString()}] [daemon-install] ${message}`);
  fileLog('daemon-install', message);
}

export interface DaemonStatus {
  supported: boolean;
  installed: boolean;
  /** 已安装守护对应的包版本（读拷贝目录里的 package.json） */
  installedVersion: string | null;
  entryPath: string | null;
}

function daemonRoot(): string {
  return path.join(os.homedir(), '.cursor-feedback', 'daemon');
}

function appRoot(): string {
  return path.join(daemonRoot(), 'app');
}

function entryPath(): string {
  return path.join(appRoot(), 'dist', 'mcp-server.js');
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function logPath(): string {
  return path.join(daemonRoot(), 'daemon.log');
}

/**
 * 定位真实 node 可执行文件。MCP server 经 npx 启动时 execPath 就是 node；
 * 万一是在 Electron 里跑（异常场景），回退常见安装路径。
 */
function findNode(): string {
  const exec = process.execPath;
  const base = path.basename(exec).toLowerCase();
  if (base === 'node' || base === 'node.exe') return exec;
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\nodejs\\node.exe']
      : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return exec; // 死马当活马：Electron 也能靠 ELECTRON_RUN_AS_NODE 跑 node 脚本
}

/** 运行中的这份包的根目录（dist 的上一级） */
function currentPkgRoot(): string {
  // __dirname 编译后是 <pkgRoot>/dist
  return path.join(__dirname, '..');
}

/**
 * 把当前包（dist + package.json + 依赖）拷贝到守护目录。
 * 依赖布局两种：npm/npx 安装时依赖在 pkgRoot 的父级 node_modules；
 * 源码 / 扩展目录时依赖在 pkgRoot/node_modules。
 */
function copySelf(): void {
  const pkgRoot = currentPkgRoot();
  const app = appRoot();
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });

  for (const item of ['dist', 'package.json']) {
    const src = path.join(pkgRoot, item);
    if (!fs.existsSync(src)) throw new Error(`当前包缺少 ${item}（${src}），无法安装守护`);
    fs.cpSync(src, path.join(app, item), { recursive: true });
  }

  const ownDeps = path.join(pkgRoot, 'node_modules');
  const parentDeps = path.resolve(pkgRoot, '..');
  let depsSrc: string | null = null;
  if (fs.existsSync(ownDeps)) {
    depsSrc = ownDeps;
  } else if (path.basename(parentDeps) === 'node_modules') {
    depsSrc = parentDeps;
  }
  if (!depsSrc) throw new Error('找不到依赖 node_modules，无法安装守护');
  fs.cpSync(depsSrc, path.join(app, 'node_modules'), {
    recursive: true,
    dereference: true,
    // npm 布局下父级 node_modules 里含 cursor-feedback 自身，跳过避免套娃拷贝
    filter: (src) => !src.includes(`${path.sep}cursor-feedback${path.sep}`) &&
      !src.endsWith(`${path.sep}cursor-feedback`),
  });
  dlog(`包已拷贝到 ${app}`);
}

/* ------------------------------ macOS (launchd) ------------------------------ */

function buildPlist(node: string): string {
  const isElectron = !/node(\.exe)?$/i.test(path.basename(node));
  const envBlock = isElectron
    ? '  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>\n  </dict>\n'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entryPath()}</string>
    <string>--daemon</string>
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath()}</string>
  <key>StandardErrorPath</key>
  <string>${logPath()}</string>
</dict>
</plist>
`;
}

function launchctl(args: string[]): void {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' });
  } catch {
    // bootout 不存在的服务等场景会报错，可忽略
  }
}

function installMac(): void {
  const node = findNode();
  const plist = plistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, buildPlist(node));
  const uid = process.getuid ? process.getuid() : 501;
  // 先卸旧再装新（重装 / 升级场景）；bootstrap 失败回退老接口 load
  launchctl(['bootout', `gui/${uid}/${LABEL}`]);
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'ignore' });
  } catch {
    launchctl(['load', '-w', plist]);
  }
  dlog('launchd 守护已注册并启动');
}

function uninstallMac(): void {
  const uid = process.getuid ? process.getuid() : 501;
  launchctl(['bootout', `gui/${uid}/${LABEL}`]);
  fs.rmSync(plistPath(), { force: true });
  dlog('launchd 守护已卸载');
}

/* ------------------------------ Windows (schtasks) ------------------------------ */

function vbsPath(): string {
  return path.join(daemonRoot(), 'daemon-launch.vbs');
}

function installWin(): void {
  const node = findNode();
  // vbs 包装：schtasks 直接跑控制台程序会闪黑窗，wscript + Run(...,0) 完全隐藏
  const vbs =
    `CreateObject("Wscript.Shell").Run """${node}"" ""${entryPath()}"" --daemon", 0, False\r\n`;
  fs.mkdirSync(daemonRoot(), { recursive: true });
  fs.writeFileSync(vbsPath(), vbs);
  try {
    execFileSync('schtasks', ['/Delete', '/TN', WIN_TASK_NAME, '/F'], { stdio: 'ignore' });
  } catch {
    // 任务不存在
  }
  execFileSync(
    'schtasks',
    ['/Create', '/TN', WIN_TASK_NAME, '/SC', 'ONLOGON', '/TR', `wscript.exe "${vbsPath()}"`, '/RL', 'LIMITED', '/F'],
    { stdio: 'ignore' },
  );
  // 立即拉起一次（不等下次登录）
  try {
    execFileSync('schtasks', ['/Run', '/TN', WIN_TASK_NAME], { stdio: 'ignore' });
  } catch {
    spawn('wscript.exe', [vbsPath()], { stdio: 'ignore', detached: true }).unref();
  }
  dlog('Windows 计划任务已注册并启动');
}

function uninstallWin(): void {
  try {
    execFileSync('schtasks', ['/Delete', '/TN', WIN_TASK_NAME, '/F'], { stdio: 'ignore' });
  } catch {
    // 任务不存在
  }
  fs.rmSync(vbsPath(), { force: true });
  dlog('Windows 计划任务已卸载');
}

/* ------------------------------ 公共入口 ------------------------------ */

export function daemonSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

export function installDaemon(): DaemonStatus {
  if (!daemonSupported()) throw new Error(`平台 ${process.platform} 暂不支持常驻守护`);
  copySelf();
  if (process.platform === 'darwin') installMac();
  else installWin();
  return daemonStatus();
}

export function uninstallDaemon(): DaemonStatus {
  if (process.platform === 'darwin') uninstallMac();
  else if (process.platform === 'win32') uninstallWin();
  fs.rmSync(appRoot(), { recursive: true, force: true });
  return daemonStatus();
}

export function daemonStatus(): DaemonStatus {
  const registered =
    process.platform === 'darwin'
      ? fs.existsSync(plistPath())
      : process.platform === 'win32'
        ? winTaskExists()
        : false;
  const entry = entryPath();
  const installed = registered && fs.existsSync(entry);
  let installedVersion: string | null = null;
  if (installed) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appRoot(), 'package.json'), 'utf-8'));
      installedVersion = typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      // 读不到版本不影响状态
    }
  }
  return {
    supported: daemonSupported(),
    installed,
    installedVersion,
    entryPath: installed ? entry : null,
  };
}

function winTaskExists(): boolean {
  try {
    execFileSync('schtasks', ['/Query', '/TN', WIN_TASK_NAME], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 守护自动升级：已安装的守护是安装时的快照，不会随 npx @latest 走。
 * IDE 里的新版 server 启动时调用这里——发现守护版本与自己不一致就静默重装
 * （重装会 bootout 旧守护、拷贝新包、重新拉起），用户零操作。
 *
 * 并发防护：多窗口 = 多个 server 同时启动，重装涉及删目录 + 整树拷贝，撞上会互相
 * 写坏。用 wx 独占锁串行化，抢不到的直接跳过（反正有人在装）；残锁超 10 分钟视为
 * 上次进程死在半路，清掉重来。
 *
 * @returns 是否真的执行了重装
 */
export function upgradeDaemonIfOutdated(currentVersion: string): boolean {
  try {
    const st = daemonStatus();
    if (!st.installed || !st.installedVersion || st.installedVersion === currentVersion) {
      return false;
    }
    const lock = path.join(daemonRoot(), 'upgrade.lock');
    try {
      const age = Date.now() - fs.statSync(lock).mtimeMs;
      if (age > 10 * 60 * 1000) fs.rmSync(lock, { force: true });
    } catch {
      // 无残锁
    }
    try {
      fs.mkdirSync(daemonRoot(), { recursive: true });
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch {
      return false; // 另一个窗口的 server 正在升级
    }
    try {
      dlog(`守护版本 ${st.installedVersion} 落后于当前 ${currentVersion}，自动重装升级`);
      installDaemon();
      dlog('守护自动升级完成');
      return true;
    } finally {
      fs.rmSync(lock, { force: true });
    }
  } catch (e) {
    // 升级失败不影响 server 正常启动，旧守护继续工作
    dlog(`守护自动升级失败（不影响本进程）：${e}`);
    return false;
  }
}
