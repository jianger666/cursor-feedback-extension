/**
 * CLI 会话拉起器：飞书 /new 命令 → 非交互模式 spawn cursor-agent。
 *
 * 关键设计（均来自实测结论，勿随意更改）：
 * - 必须用非交互 print 模式（-p）：交互式 TUI 会话对 Fable 5 会强制回到 Max Mode，
 *   次数计费的套餐一次对话被扣 10+ 次；非交互模式尊重 cli-config.json 的 maxMode=false，
 *   固定只扣 1 次请求。
 * - spawn 前每次都强制把 ~/.cursor/cli-config.json 写成 maxMode=false + 目标模型：
 *   交互式会话会把这个文件改回 max，不能信任上次的残留状态。
 * - CLI 不读 IDE 的全局 User Rules，用户的个人规则要显式注入到 prompt 里
 *   （从 ~/.cursor-feedback/cli-rules.md 读取，没有则只注入 cursor-feedback 沟通协议）。
 * - 拉起的 agent 会通过全局注册的 cursor-feedback MCP 发飞书卡片，用户在手机上
 *   直接和这个会话对话——本模块只负责拉起和收尾，过程中的交互走既有反馈链路。
 */
import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function clog(message: string) {
  console.error(`[${new Date().toISOString()}] [cli-launcher] ${message}`);
}

/** /model、/cwd 命令写入的持久化设置（~/.cursor-feedback/cli.json，跨进程/重启共享） */
export interface CliSettings {
  /** /model 设置的模型 id；缺省用 DEFAULT_MODEL */
  model?: string;
  /** /cwd 设置的默认工作目录；/new 未显式带路径时优先用它 */
  defaultCwd?: string;
}

export interface CliSessionResult {
  /** 进程退出码；被 /stop 或超时杀掉时为 null */
  code: number | null;
  /** stdout 尾部（agent 的最终回复文本） */
  output: string;
  /** stderr 尾部（失败时用于提示原因） */
  errorOutput: string;
  /** 是否因会话时长兜底超时被杀 */
  timedOut: boolean;
  /** 是否被用户 /stop 主动终止 */
  stopped: boolean;
  /** 会话运行时长（毫秒） */
  elapsedMs: number;
}

/** 磁盘全局会话锁：多窗口/守护多实例共享（飞书把命令推给哪个实例是不确定的） */
interface CliSessionLock {
  /** 会话进程 pid；0 = 刚抢到锁、spawn 还没完成 */
  pid: number;
  task: string;
  startedAt: number;
  /** 拉起会话的实例进程 pid（pid=0 阶段用它判活；收尾时校验归属） */
  ownerPid: number;
  /** 另一个实例发起了 /stop（跨实例终止时标记，让托管实例收尾文案报「已终止」而非「异常退出」） */
  stopRequested?: boolean;
}

export class CliLauncher {
  /** 默认模型：实测非交互模式下该模型 + maxMode=false 固定扣 1 次请求 */
  private static readonly DEFAULT_MODEL = 'claude-fable-5-thinking-max';
  /** 会话时长兜底：防止无人回复的 headless 会话无限续期挂着 */
  private static readonly SESSION_MAX_MS = 3 * 60 * 60 * 1000;
  /** stdout/stderr 只保留尾部，防止长会话把内存吃爆 */
  private static readonly OUTPUT_TAIL_LIMIT = 16000;

  private child: ChildProcess | null = null;
  private startedAt = 0;
  private taskBrief = '';
  private stopRequested = false;

  /* ---------- 磁盘全局会话锁 ----------
   * 「同时只跑一个 CLI 会话」必须全局生效：多窗口 + 守护进程是多实例并存，
   * 飞书把 /new、/stop 推给哪个实例是不确定的（长连接负载均衡）。只看本实例的
   * child 会被击穿：A 拉了会话，下一条 /new 推给 B，B 以为空闲又拉一个。
   * 锁文件记录会话进程 pid，任何实例都能据此判忙 / 跨实例终止；
   * 持锁进程崩溃后锁自动失效（pid 探活），不会死锁。 */

  private lockPath(): string {
    return path.join(os.homedir(), '.cursor-feedback', 'cli-session.lock');
  }

  private readLock(): CliSessionLock | null {
    try {
      const j = JSON.parse(fs.readFileSync(this.lockPath(), 'utf-8')) as CliSessionLock;
      return typeof j.pid === 'number' ? j : null;
    } catch {
      return null;
    }
  }

  private static pidAlive(pid: number): boolean {
    if (!pid || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * pid 是否确实是 cursor-agent 会话进程。防 pid 复用：锁残留（极端崩溃）后系统把同号
   * pid 分给了无关进程，跨实例 /stop 若不校验会误杀无辜。校验失败按「不是会话」处理。
   */
  private static pidLooksLikeAgent(pid: number): boolean {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf-8',
        });
        return /cursor-agent|node|cmd\.exe/i.test(out);
      }
      const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
      return /cursor-agent/i.test(out);
    } catch {
      return false;
    }
  }

  /** 当前全局是否有活跃会话（锁存在且会话进程活着；死锁视为无会话） */
  private aliveLock(): CliSessionLock | null {
    const lock = this.readLock();
    if (!lock) return null;
    // pid=0 = 另一个实例刚抢到锁、spawn 还没完成：以它的实例进程判活，避免这瞬间被当死锁误清
    const alive = lock.pid > 0
      ? CliLauncher.pidAlive(lock.pid)
      : CliLauncher.pidAlive(lock.ownerPid);
    if (!alive) {
      // 持锁会话已死（实例崩溃 / 强杀），清掉残锁
      fs.rmSync(this.lockPath(), { force: true });
      return null;
    }
    return lock;
  }

  /** 原子抢锁：wx 独占创建。返回是否抢到（false = 别的实例刚抢先） */
  private tryAcquireLock(task: string): boolean {
    // 先清死锁，再独占创建（两个实例同时 /new 时只有一个 wx 成功）
    this.aliveLock();
    const lock: CliSessionLock = { pid: 0, task, startedAt: Date.now(), ownerPid: process.pid };
    try {
      fs.mkdirSync(path.dirname(this.lockPath()), { recursive: true });
      fs.writeFileSync(this.lockPath(), JSON.stringify(lock), { flag: 'wx' });
      return true;
    } catch {
      return false;
    }
  }

  private updateLockPid(pid: number): void {
    const lock = this.readLock();
    if (lock && lock.ownerPid === process.pid) {
      fs.writeFileSync(this.lockPath(), JSON.stringify({ ...lock, pid }));
    }
  }

  private releaseLock(): void {
    const lock = this.readLock();
    if (lock && lock.ownerPid === process.pid) {
      fs.rmSync(this.lockPath(), { force: true });
    }
  }

  /** 全局视角：是否有会话在跑（本实例或其他实例拉起的都算） */
  isRunning(): boolean {
    return this.child !== null || this.aliveLock() !== null;
  }

  /** 正在运行的会话描述（用于「已有会话在跑」的回执；含其他实例拉起的会话） */
  describe(): string {
    if (this.child) {
      const mins = Math.round((Date.now() - this.startedAt) / 60000);
      return `「${this.taskBrief}」（已运行 ${mins} 分钟）`;
    }
    const lock = this.aliveLock();
    if (lock) {
      const brief = lock.task.length > 40 ? lock.task.slice(0, 40) + '…' : lock.task;
      const mins = Math.round((Date.now() - lock.startedAt) / 60000);
      return `「${brief}」（已运行 ${mins} 分钟，由另一个窗口实例托管）`;
    }
    return '';
  }

  private settingsPath(): string {
    return path.join(os.homedir(), '.cursor-feedback', 'cli.json');
  }

  readSettings(): CliSettings {
    try {
      const j = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf-8'));
      return typeof j === 'object' && j ? (j as CliSettings) : {};
    } catch {
      return {};
    }
  }

  writeSettings(patch: CliSettings): void {
    const merged = { ...this.readSettings(), ...patch };
    const p = this.settingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  }

  /** 当前生效模型：env 覆盖 > /model 持久化设置 > 默认。无论选什么模型，spawn 前都强制 maxMode=false */
  model(): string {
    return (
      process.env.CURSOR_FEEDBACK_CLI_MODEL ||
      this.readSettings().model ||
      CliLauncher.DEFAULT_MODEL
    );
  }

  /** /cwd 设置的默认工作目录（存在才返回） */
  defaultCwd(): string | null {
    const d = this.readSettings().defaultCwd;
    if (d && fs.existsSync(d)) return d;
    return null;
  }

  /**
   * 定位 cursor-agent 可执行文件。安装脚本默认放在 ~/.local/bin（mac/linux 是
   * cursor-agent，Windows 是 cursor-agent.cmd/.exe），而 MCP server 进程的 PATH
   * 通常不含它，不能只靠 PATH 兜底。
   */
  private findBinary(): string | null {
    const explicit = process.env.CURSOR_AGENT_PATH;
    if (explicit && fs.existsSync(explicit)) return explicit;
    const names =
      process.platform === 'win32'
        ? ['cursor-agent.cmd', 'cursor-agent.exe', 'cursor-agent.ps1']
        : ['cursor-agent'];
    for (const dir of [
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'cursor-agent'),
    ]) {
      for (const name of names) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
      }
    }
    return 'cursor-agent'; // 最后交给 PATH 解析，spawn error 时报错提示
  }

  /**
   * spawn 前强制写 cli-config.json：maxMode=false + 目标模型。
   * 每次都写——交互式会话会把它改回 max，残留状态不可信。
   */
  private ensureMaxModeOff(): void {
    const p = path.join(os.homedir(), '.cursor', 'cli-config.json');
    let cfg: Record<string, unknown> = {};
    try {
      cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      // 文件不存在或损坏时从空对象重建（cursor-agent 会补齐其余字段）
    }
    cfg.maxMode = false;
    cfg.model = { modelId: this.model(), maxMode: false };
    cfg.hasChangedDefaultModel = true;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    clog(`cli-config.json 已写入 maxMode=false, model=${this.model()}`);
  }

  /** 用户自定义注入规则：~/.cursor-feedback/cli-rules.md（可选） */
  private readUserRules(): string {
    try {
      const p = path.join(os.homedir(), '.cursor-feedback', 'cli-rules.md');
      const text = fs.readFileSync(p, 'utf-8').trim();
      return text;
    } catch {
      return '';
    }
  }

  /**
   * 组装最终 prompt：cursor-feedback 沟通协议（必注入，否则 headless 会话无法与
   * 手机上的用户交互）+ 用户自定义规则 + 任务本体。
   */
  private buildPrompt(task: string): string {
    const parts: string[] = [];
    parts.push(
      '【会话背景与必须遵守的沟通协议】\n' +
      '- 用户不在电脑前，正通过手机飞书与你交流；你是被飞书 /new 命令拉起的 headless 会话。\n' +
      '- 与用户的所有沟通必须通过 MCP 工具 cursor-feedback 的 interactive_feedback 进行' +
      '（它的卡片会推送到用户飞书）：需要确认、汇报进展、完成任务时都调用它。\n' +
      '- interactive_feedback 返回以 [TIMEOUT_KEEP_WAITING] 开头时表示用户暂未回复，' +
      '必须立即用相同 project_directory 再次调用继续等待；以 [TIMEOUT_END] 开头才可结束。\n' +
      '- project_directory 参数固定传当前工作目录。',
    );
    const userRules = this.readUserRules();
    if (userRules) {
      parts.push('【用户附加规则（必须遵守）】\n' + userRules);
    }
    parts.push('【任务】\n' + task);
    return parts.join('\n\n');
  }

  /**
   * 拉起一个非交互 CLI 会话。调用方需先用 isRunning() 确认没有并发会话。
   * @returns 启动失败时返回错误说明字符串；成功返回 null，结果经 onDone 回调
   */
  start(task: string, cwd: string, onDone: (result: CliSessionResult) => void): string | null {
    if (this.isRunning()) return '已有一个 CLI 会话在运行：' + this.describe();
    // 原子抢全局锁：两个实例同时收到 /new 时只有一个能抢到
    if (!this.tryAcquireLock(task)) {
      return '已有一个 CLI 会话在运行：' + (this.describe() || '（另一个窗口实例刚刚抢先拉起）');
    }

    try {
      this.ensureMaxModeOff();
    } catch (e) {
      this.releaseLock();
      return '写入 cli-config.json 失败：' + e;
    }

    const bin = this.findBinary();
    if (!bin) {
      this.releaseLock();
      return '找不到 cursor-agent，可通过环境变量 CURSOR_AGENT_PATH 指定路径。';
    }

    const workDir = fs.existsSync(cwd) ? cwd : os.homedir();
    const prompt = this.buildPrompt(task);

    let stdout = '';
    let stderr = '';
    const append = (buf: string, chunk: Buffer): string => {
      const next = buf + chunk.toString();
      return next.length > CliLauncher.OUTPUT_TAIL_LIMIT
        ? next.slice(next.length - CliLauncher.OUTPUT_TAIL_LIMIT)
        : next;
    };

    const args = ['-p', '--trust', '--model', this.model(), prompt];
    const isWin = process.platform === 'win32';
    // Windows 上 .cmd/.ps1 不能直接 spawn（Node 18.20+ 禁止），需经 cmd.exe 转发
    const viaCmdShell = isWin && /\.(cmd|bat|ps1)$/i.test(bin);
    const spawnBin = viaCmdShell ? 'cmd.exe' : bin;
    const spawnArgs = viaCmdShell ? ['/d', '/s', '/c', bin, ...args] : args;
    const pathSep = isWin ? ';' : ':';

    let child: ChildProcess;
    try {
      child = spawn(spawnBin, spawnArgs, {
        cwd: workDir,
        env: {
          ...process.env,
          PATH: `${path.join(os.homedir(), '.local', 'bin')}${pathSep}${process.env.PATH || ''}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX：独立进程组，终止时连 cursor-agent 自己 spawn 的子进程一起杀干净；
        // Windows 走 taskkill /T，不需要 detached
        detached: !isWin,
      });
    } catch (e) {
      this.releaseLock();
      return '拉起 cursor-agent 失败：' + e;
    }

    this.child = child;
    this.startedAt = Date.now();
    this.taskBrief = task.length > 40 ? task.slice(0, 40) + '…' : task;
    this.stopRequested = false;
    this.updateLockPid(child.pid || 0);
    clog(`CLI 会话已拉起: pid=${child.pid} cwd=${workDir} model=${this.model()}`);

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      clog('会话超过时长上限，强制终止');
      CliLauncher.killTree(child, 'SIGKILL');
    }, CliLauncher.SESSION_MAX_MS);

    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });

    const finish = (code: number | null) => {
      clearTimeout(killTimer);
      const elapsedMs = Date.now() - this.startedAt;
      // 跨实例 /stop 会在锁上打 stopRequested 标记再杀进程，这里一并算「主动终止」
      const lockAtFinish = this.readLock();
      const stopped =
        this.stopRequested ||
        !!(lockAtFinish && lockAtFinish.ownerPid === process.pid && lockAtFinish.stopRequested);
      this.child = null;
      this.releaseLock();
      clog(`CLI 会话结束: code=${code} elapsed=${Math.round(elapsedMs / 1000)}s timedOut=${timedOut} stopped=${stopped}`);
      onDone({
        code,
        output: stdout.trim(),
        errorOutput: stderr.trim(),
        timedOut,
        stopped,
        elapsedMs,
      });
    };

    child.on('error', (err) => {
      // spawn 失败（如二进制不存在）也走统一收尾，错误进 errorOutput
      stderr = append(stderr, Buffer.from(String(err)));
      finish(null);
    });
    child.on('close', (code) => finish(code));

    return null;
  }

  /**
   * 用户 /stop 主动终止会话。返回是否有会话被终止。
   * 跨实例：会话可能由另一个窗口实例托管（飞书把 /stop 推给了不同实例），
   * 此时按锁里的 pid 直接终止会话进程，托管实例的 close 回调会自然收尾并回执。
   */
  stop(): boolean {
    if (this.child) {
      this.stopRequested = true;
      CliLauncher.killTree(this.child, 'SIGTERM');
      // SIGTERM 5s 内没退出则补 SIGKILL
      const child = this.child;
      setTimeout(() => {
        if (this.child === child) {
          CliLauncher.killTree(child, 'SIGKILL');
        }
      }, 5000);
      return true;
    }
    const lock = this.aliveLock();
    if (lock && lock.pid > 0) {
      if (!CliLauncher.pidLooksLikeAgent(lock.pid)) {
        // pid 已被无关进程复用（残锁）：清锁但绝不误杀
        clog(`锁 pid=${lock.pid} 不是 cursor-agent（已被复用），清除残锁`);
        fs.rmSync(this.lockPath(), { force: true });
        return false;
      }
      clog(`跨实例终止 CLI 会话: pid=${lock.pid}（由 ${lock.ownerPid} 托管）`);
      try {
        // 先在锁上打「主动终止」标记，托管实例收尾时据此报「已终止」而非「异常退出」
        fs.writeFileSync(this.lockPath(), JSON.stringify({ ...lock, stopRequested: true }));
      } catch {
        // 标记失败只影响收尾文案
      }
      try {
        // 会话进程是托管实例 detached 出来的进程组组长，杀整组
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(lock.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { process.kill(-lock.pid, 'SIGTERM'); } catch { process.kill(lock.pid, 'SIGTERM'); }
        }
      } catch {
        // 进程刚好自己结束了
      }
      return true;
    }
    return false;
  }

  /**
   * 终止整个进程树：POSIX 杀进程组（detached spawn 后 child.pid 即组长），
   * Windows 用 taskkill /T 递归终止，连 agent 自己拉的子进程一起清理。
   */
  private static killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        try { child.kill(); } catch { /* 进程可能已退出 */ }
      }
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* 进程可能已退出 */ }
    }
  }
}
