/**
 * 落盘日志：server 侧所有日志除了打到 stderr（Cursor 的 MCP 日志），同时写入
 * ~/.cursor-feedback/logs/YYYY-MM-DD.log，供「导出诊断包」排查用户现场问题。
 * 设计约束：绝不能因为日志失败影响主流程（全部吞错）；日志量小，直接同步追加（崩溃不丢行）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 日志保留天数：超过的按文件名日期清理 */
const RETENTION_DAYS = 7;

function logsDir(): string {
  return path.join(os.homedir(), '.cursor-feedback', 'logs');
}

/** 本地日期 YYYY-MM-DD（日志按用户本地时区的自然日切割） */
function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let cleanedForDay = '';

/** 清理过期日志：每个进程每天最多执行一次 */
function cleanupOldLogs(today: string): void {
  if (cleanedForDay === today) return;
  cleanedForDay = today;
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const cutoffDay = localDay(cutoff);
    for (const f of fs.readdirSync(logsDir())) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
      // 文件名日期字典序即时间序；不匹配命名规则的文件不动
      if (m && m[1] < cutoffDay) {
        fs.rmSync(path.join(logsDir(), f), { force: true });
      }
    }
  } catch {
    // 目录不存在或不可读，忽略
  }
}

/** 追加一行日志到当天的文件。tag 用于区分模块（mcp / feishu / cli-launcher）。 */
export function fileLog(tag: string, message: string): void {
  try {
    const today = localDay();
    fs.mkdirSync(logsDir(), { recursive: true });
    cleanupOldLogs(today);
    const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`;
    fs.appendFileSync(path.join(logsDir(), `${today}.log`), line);
  } catch {
    // 磁盘满/权限问题都不能影响主流程
  }
}

/**
 * 读取最近的日志尾部（今天优先，不够再补前一天），用于诊断包。
 * 返回不超过 maxBytes 的文本。
 */
export function readRecentLogs(maxBytes = 256 * 1024): string {
  try {
    const files = fs
      .readdirSync(logsDir())
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort()
      .slice(-2);
    let text = '';
    for (const f of files) {
      text += `===== ${f} =====\n`;
      text += fs.readFileSync(path.join(logsDir(), f), 'utf-8');
    }
    return text.length > maxBytes ? '…(前文截断)\n' + text.slice(text.length - maxBytes) : text;
  } catch {
    return '（没有日志文件）';
  }
}
