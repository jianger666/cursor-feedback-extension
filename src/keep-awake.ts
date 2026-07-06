/**
 * 防睡眠模块：常驻守护进程启用，保证「下班锁屏后手机随时能唤起」。
 *
 * 原则：只在接电源时阻止系统睡眠，绝不偷耗电池；锁屏/关屏不受影响（本来就不断网）。
 * - macOS：拉一个 `caffeinate -s` 子进程。-s 语义本身就是「仅接电时阻止系统睡眠」，
 *   电池供电时自动不生效，无需自己轮询电源状态；进程退出断言自动释放。
 * - Windows：拉一个 PowerShell 子进程调 Win32 SetThreadExecutionState(
 *   ES_CONTINUOUS | ES_SYSTEM_REQUIRED)。API 本身不区分电源，故脚本内每 30s 轮询
 *   电池状态，接电才持有断言、拔电立即释放。无需管理员、不改用户电源计划，
 *   进程退出断言自动失效。
 */
import { spawn, ChildProcess } from 'child_process';

function klog(message: string) {
  console.error(`[${new Date().toISOString()}] [keep-awake] ${message}`);
}

/**
 * Windows 常驻脚本：持有/释放电源断言 + 电源状态轮询。
 * ES_CONTINUOUS=0x80000000, ES_SYSTEM_REQUIRED=0x00000001。
 * PowerLineStatus: Online=接电（台式机无电池也是 Online）。
 */
const WIN_KEEP_AWAKE_PS = `
Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
Add-Type -AssemblyName System.Windows.Forms
$held = $false
while ($true) {
  $ac = [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -eq 'Online'
  if ($ac -and -not $held) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; $held = $true }
  elseif (-not $ac -and $held) { [W.P]::SetThreadExecutionState(0x80000000) | Out-Null; $held = $false }
  Start-Sleep -Seconds 30
}
`;

export class KeepAwake {
  private child: ChildProcess | null = null;
  private stopped = false;

  isActive(): boolean {
    return this.child !== null;
  }

  /** 启动防睡眠（幂等）。不支持的平台（Linux 等）静默跳过。 */
  start(): void {
    if (this.child) return;
    this.stopped = false;

    let bin: string;
    let args: string[];
    if (process.platform === 'darwin') {
      bin = '/usr/bin/caffeinate';
      args = ['-s'];
    } else if (process.platform === 'win32') {
      bin = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_KEEP_AWAKE_PS];
    } else {
      klog(`平台 ${process.platform} 暂不支持防睡眠，跳过`);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: 'ignore' });
    } catch (e) {
      klog('启动防睡眠子进程失败: ' + e);
      return;
    }
    this.child = child;
    klog(`防睡眠已启动: pid=${child.pid}（仅接电源时阻止系统睡眠）`);

    child.on('error', (err) => {
      klog('防睡眠子进程出错: ' + err);
      this.child = null;
    });
    child.on('exit', () => {
      this.child = null;
      // 意外退出（如被任务管理器杀掉）时自动重启，保证常驻语义；主动 stop 不重启
      if (!this.stopped) {
        klog('防睡眠子进程意外退出，10s 后重启');
        setTimeout(() => {
          if (!this.stopped) this.start();
        }, 10000);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (!this.child) return;
    try { this.child.kill(); } catch { /* 进程可能已退出 */ }
    this.child = null;
    klog('防睡眠已停止');
  }
}
