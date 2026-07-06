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
import { spawn, ChildProcess } from 'child_process';
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

  isRunning(): boolean {
    return this.child !== null;
  }

  /** 正在运行的会话描述（用于「已有会话在跑」的回执） */
  describe(): string {
    if (!this.child) return '';
    const mins = Math.round((Date.now() - this.startedAt) / 60000);
    return `「${this.taskBrief}」（已运行 ${mins} 分钟）`;
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
    if (this.child) return '已有一个 CLI 会话在运行：' + this.describe();

    try {
      this.ensureMaxModeOff();
    } catch (e) {
      return '写入 cli-config.json 失败：' + e;
    }

    const bin = this.findBinary();
    if (!bin) return '找不到 cursor-agent，可通过环境变量 CURSOR_AGENT_PATH 指定路径。';

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
      return '拉起 cursor-agent 失败：' + e;
    }

    this.child = child;
    this.startedAt = Date.now();
    this.taskBrief = task.length > 40 ? task.slice(0, 40) + '…' : task;
    this.stopRequested = false;
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
      const stopped = this.stopRequested;
      this.child = null;
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

  /** 用户 /stop 主动终止会话。返回是否有会话被终止。 */
  stop(): boolean {
    if (!this.child) return false;
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
