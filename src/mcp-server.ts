#!/usr/bin/env node
/**
 * MCP Server 独立入口文件
 * 
 * 此文件用于作为独立进程运行 MCP Server
 * Cursor/VS Code 会通过 stdio 与此服务器通信
 * 
 * 使用方法:
 * 在 Cursor 的 MCP 配置中添加:
 * {
 *   "mcpServers": {
 *     "cursor-feedback": {
 *       "command": "node",
 *       "args": ["/path/to/dist/mcp-server.js"]
 *     }
 *   }
 * }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { FeishuBridge, FeishuConfig, FeishuInboundReply } from './feishu.js';
import { CliLauncher, CliSessionResult } from './cli-launcher.js';
import { KeepAwake } from './keep-awake.js';
import { installDaemon, uninstallDaemon, daemonStatus, daemonSupported, upgradeDaemonIfOutdated } from './daemon-install.js';
import { fileLog, readRecentLogs } from './logger.js';

// ⚠️ MCP stdio 协议要求 stdout 只承载 JSON-RPC 消息。第三方库（尤其飞书 SDK 的内置 logger，
// 输出形如 "[info]: [...]"）会用 console.log/info/debug 往 stdout 打日志，一旦混入就会让
// Cursor 端 JSON 解析失败、连接进入 failed（表现为 "Not connected"）。这里在进程最早期把这三个
// 统一重定向到 stderr，保证 stdout 纯净。
// 注：warn/error 在 Node 中本就走 stderr；MCP SDK 用 process.stdout.write 直接发消息，不经 console，故不受影响。
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

// 调试日志输出到 stderr（不影响 stdio 通信）
function debugLog(message: string) {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${message}`);
  fileLog('mcp', message);
}

// 包版本真相源：package.json（dist/mcp-server.js 的上一级目录）。读不到时兜底 0.0.0。
const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * 反馈请求接口
 */
interface FeedbackRequest {
  id: string;
  summary: string;
  projectDir: string;
  timeout: number;
  timestamp: number;
}

/**
 * 反馈响应接口
 */
interface FeedbackResponse {
  interactive_feedback: string;
  images: Array<{
    name: string;
    data: string;
    size: number;
  }>;
  attachedFiles: string[];
  project_directory: string;
}

/**
 * 等待反馈的结果，必须区分三态：
 * - feedback：拿到了用户反馈
 * - timeout：真正等满了 timeout 窗口仍无人回复（可走「超时续期」）
 * - superseded：被同窗口/同进程的新一轮请求主动取代（绝不能当成超时去重试）
 *
 * 三态拆分是为了根除「取消风暴」：多窗口 / AgentWindow 复用同一个 MCP 进程时，
 * 旧实现把「被取代」误判成「超时」→ 返回续期提醒 → AI 立即重试 → 又取消别人，无限忙等。
 */
type WaitOutcome =
  | { kind: 'feedback'; data: FeedbackResponse }
  | { kind: 'timeout' }
  | { kind: 'superseded' };

/**
 * MCP Feedback Server
 */
class McpFeedbackServer {
  private server: Server;
  private httpServer: http.Server | null = null;
  private port: number;
  private readonly basePort: number;
  private static readonly PORT_SCAN_RANGE = 20; // 与插件端扫描范围保持一致
  
  // 待处理的反馈请求
  private pendingRequests: Map<string, {
    resolve: (value: FeedbackResponse | null) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    // 归属窗口（用于 cancelStalePending 按窗口精确作废，避免误杀其他窗口/agent 的等待）
    projectDir: string;
    // 超时回调（暂停恢复时需要重新 setTimeout 同一段收尾逻辑）
    onTimeout: () => void;
    // 倒计时暂停支持：deadline = 计时器到期的绝对时刻（运行态有效）；
    // paused = 用户手动暂停；remainingMs = 暂停那一刻的剩余时间（暂停态有效）
    deadline: number;
    paused: boolean;
    remainingMs: number;
    // 全量请求对象：/api/feedback/current 按窗口（workspace）挑请求返回给插件展示用
    request: FeedbackRequest;
    // 等待本请求结果的所有 MCP 调用（首个调用 + 被判定为重复投递而 join 进来的调用）。
    // 背景：Cursor 客户端/传输层偶发对同一次 tool call 重复投递（实测会在某一时刻把进程内
    // 所有 in-flight 调用各重投一遍，距原投递可晚至 3~8 分钟），旧实现把重投当「新请求」→
    // cancelStalePending 顶掉原调用 → AI 收到 SUPERSEDED 提前收尾。
    // 现在重复投递直接共享同一个等待，结果对所有 waiter 广播。
    waiters: Array<(outcome: WaitOutcome) => void>;
    // 发起本请求的 JSON-RPC 请求 id（同一连接内唯一）。客户端重投若复用同一 id，
    // 可据此精确识别重复投递，比 summary 内容启发式更可靠。
    wireId?: string;
  }> = new Map();

  // 当前反馈请求
  private currentRequest: FeedbackRequest | null = null;

  // 飞书桥接（可选；未配置时不加载 SDK、零开销）
  private feishu = new FeishuBridge();
  private feishuRoutingSetup = false;
  // 飞书 /new 命令拉起的 headless CLI 会话（同一实例同时最多一个）
  private cliLauncher = new CliLauncher();
  /**
   * 抢跑暂存：用户在「上一轮反馈刚结束、下一轮卡片还没注册」的空窗里直接发来的「无主」消息。
   * 暂存后等下一轮 pending 一注册立即兑现，避免回复石沉大海（修复用户反馈的竞态 bug）。
   */
  private stashedInbound:
    | {
        text: string;
        chatId: string;
        images: FeedbackResponse['images'];
        files: string[];
        at: number;
        messageId: string;
        /** 本条暂存的有效期（无主消息 5s；回复「刚超时」卡片 15s，见 stashInbound 调用方） */
        ttlMs: number;
        /** 限定只能被该窗口（projectDir）的新一轮认领；无主消息不限定 */
        forProjectDir?: string;
      }
    | null = null;
  /** 抢跑暂存有效期：覆盖「AI 刚结束、正要调下一轮 feedback」的竞态间隙（通常 1-3s）。
   *  取 5s——太长会把已脱离语境的旧消息硬塞进很久后才出现的新一轮，造成上下文错乱（像答非所问）。 */
  private static readonly STASH_TTL_MS = 5000;
  /**
   * 「刚超时」请求的续接窗口：超时续期开启时，AI 收到 TIMEOUT_KEEP_WAITING 后重新发起下一轮
   * 通常要 2~10s（取决于模型和上下文大小）。这段空窗内用户的面板提交 / 对旧卡片的回复
   * 都应暂存并续接到下一轮，而不是报「Request not found / 已结束」把用户内容丢掉。
   */
  private static readonly REJOIN_TTL_MS = 15000;
  /** 最近超时结束的请求（id → 归属窗口/时刻），供面板提交与飞书旧卡片回复「续接」下一轮 */
  private recentlyTimedOut = new Map<string, { projectDir: string; at: number }>();
  /** 面板在超时空窗内提交的反馈：暂存到下一轮 pending 注册时立即兑现 */
  private panelStash: { feedback: FeedbackResponse; projectDir: string; at: number } | null = null;
  /**
   * 忙时消息队列：AI 正在干活（该项目空间没有等待中的反馈请求）时用户发来的消息
   * 不再丢弃，而是按项目空间排队；等 AI 下一轮调 interactive_feedback 时合并送达，
   * 并附「任务期间追加」提示头。飞书与面板消息共用同一个队列（按到达顺序），
   * 飞书侧开关见 FeishuBridge.queueWhenBusy（面板 / FEISHU_QUEUE）；面板排队恒可用。
   */
  private queuedInbound: Array<{
    /** 队列项唯一 id：面板撤回按 id 定位（at 时间戳理论上可能撞车，不能当主键） */
    id: string;
    text: string;
    chatId: string;
    images: FeedbackResponse['images'];
    files: string[];
    at: number;
    messageId: string;
    /** 消息来源渠道：飞书消息有回执链路（表情/引用回复），面板消息靠轮询下发的队列列表反馈状态 */
    source: 'feishu' | 'panel';
    /** 归属项目空间：只被该项目的下一轮反馈请求消费 */
    forProjectDir: string;
    /** 过期定时器：到点仍未被读取则出队（飞书消息回执用户「未送达」，面板消息从列表消失） */
    expiryTimer: ReturnType<typeof setTimeout>;
  }> = [];
  /** 队列项 id 自增序号（配合时间戳保证进程内唯一） */
  private queueSeq = 0;
  /** 队列消息未被读取的兜底时长：超过视为对话已结束，回执用户避免静默丢失 */
  private static readonly QUEUE_TTL_MS = 60 * 60 * 1000;
  /** 队列长度上限：极端情况下防止无限堆积 */
  private static readonly QUEUE_MAX = 100;
  /** 暂存过期提示定时器：到点仍未被认领则「回复」那条消息告知没送到，避免静默丢弃 */
  private stashExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 「我的窗口」判定为已关闭的空闲阈值：本实例曾被自己窗口插件轮询，但超过此时长没再收到
   *（只剩别的窗口在扫端口）→ 视为我的窗口已关、本实例是僵尸：不再上报 pending，避免污染全局计数。
   */
  private static readonly OWNER_IDLE_MS = 12000;
  // 最近一次被飞书回复 resolve 的请求：供插件端精确区分「飞书回复」与「超时」，
  // 避免超时续期（request 也会短暂为 null）被误判成飞书回复而错误重置面板。
  private lastFeishuResolved: { id: string; at: number } | null = null;

  // 超时续期开关真相源：磁盘（UI 改过、跨窗口共享、重启保留）> env MCP_AUTO_RETRY > 默认开。
  // 由 POST /api/settings/autoRetry 广播写入，不再从轮询 query 同步（曾致多窗口互相覆盖抖动）。
  // null = 没被磁盘/UI 覆盖，poll 时回退环境变量 / 默认值。
  private autoRetryOverride: boolean | null = null;
  // server 级设置的磁盘持久化路径（与飞书凭证同目录，跨进程/重启共享真相源）
  private readonly settingsStorePath = path.join(os.homedir(), '.cursor-feedback', 'settings.json');

  // 所属工作区（只在 AI 调用 feedback 时设置）
  // 只有来自同一工作区的轮询才会更新活动时间
  private ownerWorkspace: string | null = null;

  // owner 身份是否已被真实窗口的轮询验证过。验证后 ownerWorkspace 不再被后续调用改写：
  // AI 传的 project_directory 是「正在操作的项目」，不一定等于窗口工作区（同窗口操作兄弟/子目录很常见），
  // 每次改写会让插件心跳失配 → 实例被防线 3 当僵尸误杀（等待反馈中直接 Connection closed）。
  private ownerConfirmed: boolean = false;

  // Server 启动时间
  private readonly startTime: number = Date.now();

  // 最近一次活动时间（任意 HTTP 轮询 / MCP 调用都会刷新）
  // 用于 watchdog 判定是否所有 Cursor 窗口都已关闭
  private lastActivityTime: number = Date.now();

  // 「我的窗口」最近一次轮询时间：仅被「workspace 匹配本实例归属」的插件轮询刷新。
  // 关键：lastActivityTime 会被任意 HTTP（含别的活跃窗口对全端口的扫描）刷新，无法识别僵尸——
  // 别的窗口的端口扫描会给已关窗口的残留 server 续命。改用本字段判定「我的窗口是否还开着」。
  private lastOwnerPollTime: number = Date.now();
  // 是否曾收到过「我的窗口」的插件轮询：区分「Cursor 插件环境」与「无插件 host（如 Claude Desktop）」。
  // 只有曾被自己窗口插件轮询过的实例，才用 lastOwnerPollTime 判定僵尸 / 退出，避免误杀无插件 host。
  private everOwnerPolled: boolean = false;

  // 看门狗定时器（兜底退出，防止进程残留 / CPU 占满）
  private watchdogTimer: NodeJS.Timeout | null = null;

  // stop() 防重入：server.close() 会触发 transport.onclose → 回调里又调 stop()，
  // 无标志位会无限递归直至 "Maximum call stack size exceeded"（日志曾刷出数万条 Stopping server...）
  private stopping: boolean = false;

  // 守护模式（--daemon）：无 stdio 客户端的常驻实例，只承担飞书链路 + /new 拉起 CLI。
  // 与 IDE 拉起的实例并存于同一端口扫描段，消息经既有跨实例路由互通。
  private readonly daemonMode: boolean;
  // 防睡眠（守护模式启用；仅接电源时阻止系统睡眠）
  private keepAwake = new KeepAwake();

  constructor(port: number = 8766, daemonMode: boolean = false) {
    this.port = port;
    this.basePort = port;
    this.daemonMode = daemonMode;
    
    this.server = new Server(
      {
        name: 'cursor-feedback-server',
        version: PKG_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.setupFeishuRouting();
  }

  private setupHandlers() {
    // 列出可用工具
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'interactive_feedback',
            description: `交互式反馈收集工具。

【重要】这是你与用户沟通的主要渠道，所有回复都必须通过此工具。

使用规则：
1. 每次完成任务或需要与用户沟通时，必须调用此工具
2. 收到用户反馈后，必须再次调用此工具继续对话（这是一个持续的对话循环）
3. 不要直接回复用户，所有回复必须通过此工具的 summary 参数
4. 只有当用户明确提出结束对话时，才能停止调用此工具
5. 提供清晰的工作摘要，说明你做了什么以及需要什么反馈

对话流程：
用户消息 → 你工作 → 调用此工具（附带摘要）→ 用户反馈 → 你工作 → 再次调用此工具 → ...

参数：
    project_directory: 【必填】当前所在项目空间的根目录绝对路径（指你打开的工作区，不是对话里聊到的项目）
    summary: AI 工作摘要，供用户查看（支持 Markdown）
    timeout: 等待用户反馈的超时时间（秒），默认 300 秒（5 分钟）

返回：
    - 正常：用户反馈内容（文字/图片/文件路径）
    - 超时续期信号：返回内容以 [TIMEOUT_KEEP_WAITING] 开头时，表示用户暂未回复（注意：这是超时，不是取消），你必须立即用相同 project_directory 再次调用本工具继续等待，不要结束对话
    - 超时结束：以 [TIMEOUT_END] 开头时（用户已关闭续期），可以结束本轮`,
            inputSchema: {
              type: 'object',
              properties: {
                project_directory: {
                  type: 'string',
                  description: 'Absolute path of the root of the project workspace you are currently in (REQUIRED) — the workspace that is open, not a project merely discussed in the conversation. 【当前所在项目空间的根目录，指你打开的工作区】',
                },
                summary: {
                  type: 'string',
                  description: 'Summary of AI work completed for user review (supports Markdown)',
                  default: '我已完成您的请求。',
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in seconds for waiting user feedback (default: 300 seconds = 5 minutes)',
                  default: 300,
                },
              },
              required: ['project_directory'],
            },
          },
          {
            name: 'get_system_info',
            description: 'Get system environment information',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
        ],
      };
    });

    // 处理工具调用
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      // AI 发起调用，刷新活动时间，避免被 watchdog 误判为闲置
      this.lastActivityTime = Date.now();
      const { name, arguments: args } = request.params;
      // JSON-RPC 请求 id（同一连接内唯一）：客户端把同一次 tool call 重复投递时若复用
      // 同一 id，可据此做精确去重 / 结果重放（比 summary 内容启发式可靠）。
      const wireKey = extra?.requestId !== undefined ? String(extra.requestId) : undefined;

      try {
        switch (name) {
          case 'interactive_feedback':
            return await this.handleInteractiveFeedback(args, wireKey);
          case 'get_system_info':
            return this.handleGetSystemInfo();
          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        debugLog(`Error in tool ${name}: ${error}`);
        return {
          content: [{ type: 'text', text: `Tool error: ${error}` }],
          isError: true,
        };
      }
    });
  }

  /**
   * 处理交互式反馈请求
   * @param wireKey 本次调用的 JSON-RPC 请求 id（用于重复投递的精确识别与结果重放）
   */
  private async handleInteractiveFeedback(
    args: Record<string, unknown> | undefined,
    wireKey?: string,
  ): Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  }> {
    // 参数校验：project_directory 是必填项
    if (!args?.project_directory) {
      const receivedParams = JSON.stringify(args || {});
      return {
        content: [{
          type: 'text',
          text: `参数错误：缺少必填参数 project_directory。请查看 interactive_feedback 工具描述后使用正确参数重新调用。\n\n你传入的参数：${receivedParams}`,
        }],
        isError: true,
      };
    }

    // 归属直接用 AI 每轮传入的 project_directory（精确指向当前发起对话的窗口）。
    // 不读 WORKSPACE_FOLDER_PATHS：那是进程级固定值，多窗口共享 / 复用同一个 MCP 进程时只反映
    // 「首个拉起进程的窗口」，会把反馈发错窗口、当前窗口收不到（用户反馈的 bug）。
    const projectDir = (args.project_directory as string) || '';
    // summary 支持别名 message
    const summary = (args?.summary as string) || (args?.message as string) || '我已完成您的请求。';
    // 超时时间优先级：环境变量 > 工具参数 > 默认值（300秒）
    // 这样用户配置的环境变量永远生效，不会被 AI 覆盖
    const envTimeout = process.env.MCP_FEEDBACK_TIMEOUT ? parseInt(process.env.MCP_FEEDBACK_TIMEOUT, 10) : null;
    const timeout = envTimeout || (args?.timeout as number) || 300;

    const requestId = this.generateRequestId();

    // 重复投递识别：客户端/传输层会把同一次 tool call 原样重复投递（实测某一时刻把进程内
    // 所有 in-flight 调用各重投一遍，距原投递可晚至 3~8 分钟，无固定上限）。重复投递必须
    // join 原等待共享结果，绝不能当新一轮：不发新卡、不顶旧请求——顶了会让原调用收到
    // SUPERSEDED（AI 误以为被新会话取代而提前收尾），且重投开出的幽灵卡片没人认领，
    // 用户回复它只会石沉大海。
    const dup = this.findDuplicatePending(projectDir, summary, timeout, wireKey);
    if (dup) {
      debugLog(`Duplicate delivery detected (matched by ${dup.via}) for request ${dup.id}; joining its wait instead of superseding`);
      const outcome = await new Promise<WaitOutcome>((res) => dup.waiters.push(res));
      this.rememberSettledWire(wireKey, outcome, dup.id);
      return this.outcomeToResult(outcome, dup.id);
    }

    // 迟到的重复投递（原请求已结束）：同 wire id 精确命中已结束请求 → 原样重放当时的结果。
    // 绝不能开新一轮：原调用早已返回、没人会认领新卡，用户回复只会丢失。
    // 只按 wire id 匹配、绝不按 summary——AI 超时续期的新一轮常复用同一句 summary，
    // 按内容重放旧超时会造成「新调用秒收超时 → 立即重调 → 又秒收」的快速空转。
    if (wireKey) {
      const settled = this.settledByWire.get(wireKey);
      if (settled) {
        debugLog(`Late duplicate delivery (wire id ${wireKey}) for settled request ${settled.requestId}; replaying its outcome`);
        return this.outcomeToResult(settled.outcome, settled.requestId);
      }
    }

    // 作废上一轮残留的「僵尸」请求：单实例单窗口同时只应有一个活跃反馈请求。
    // 旧请求多半是对话被压缩 / 客户端取消后还卡在 await 的残留（要等 timeout 才自然结束），
    // 不清理会让 pendingCount 虚高、全局视角误判「多个窗口在等」
    //（即你看到的两个一模一样的 cursor-feedback-extension）。
    this.cancelStalePending(projectDir);

    // AI 调用 feedback 时设置 ownerWorkspace；但 owner 一旦被真实窗口的轮询验证过（ownerConfirmed）
    // 就锁定不再改写——project_directory 只代表 AI 正在操作的项目，改写已验证的窗口身份
    // 会让心跳失配、实例被防线 3 误杀。
    const normalizedProjectDir = this.normalizePath(projectDir);
    if (!this.ownerConfirmed) {
      this.ownerWorkspace = normalizedProjectDir;
      debugLog(`Owner workspace set to: ${this.ownerWorkspace}`);
    } else if (normalizedProjectDir !== this.ownerWorkspace) {
      debugLog(
        `Owner workspace kept as ${this.ownerWorkspace} (confirmed by window polling); ` +
        `request project ${normalizedProjectDir} differs and does not rewrite owner`
      );
    }
    
    // 创建反馈请求
    const request: FeedbackRequest = {
      id: requestId,
      summary,
      projectDir,
      timeout,
      timestamp: Date.now(),
    };
    this.currentRequest = request;

    debugLog(`Feedback request created: ${requestId}`);
    debugLog(`Summary: ${summary}`);
    debugLog(`Project: ${projectDir}`);
    debugLog(`Timeout: ${timeout}s`);
    debugLog(`Waiting for VS Code extension to collect feedback...`);

    // 飞书：已配置则推送一张反馈请求卡片（失败不影响插件主流程）。
    // 例外：忙时队列里已有本项目的排队消息 → 本轮会在注册后立即被队列兑现，
    // 卡片发出去马上就过期（用户回复只会得到「已结束」），干脆不发。
    if (this.feishu.isConfigured() && !this.hasQueuedFor(projectDir)) {
      this.feishu.sendFeedbackCard(requestId, summary, projectDir).catch(() => {});
    }

    try {
      // 等待用户反馈
      const outcome = await this.waitForFeedback(request, timeout * 1000, wireKey);
      this.rememberSettledWire(wireKey, outcome, requestId);
      return this.outcomeToResult(outcome, requestId);
    } catch (error) {
      debugLog(`Error collecting feedback: ${error}`);
      return {
        content: [
          {
            type: 'text',
            text: `Error collecting feedback: ${error}`,
          },
        ],
      };
    } finally {
      // 只清自己的 currentRequest：被 cancelStalePending 提前作废的旧（僵尸）请求，其 finally 触发时
      // currentRequest 可能已是新一轮请求，绝不能误清空（否则刚发起的请求会被旧请求的收尾抹掉）。
      if (this.currentRequest?.id === requestId) this.currentRequest = null;
      // 仅清「待回复」计数，保留卡片 message_id 映射：用户回复一张已结束（超时/已提交/已回复）的
      // 旧卡片时仍能被 resolveParent 命中、回执「已结束」，不会因映射丢失被当成陌生卡片广播、石沉大海。
      this.feishu.clearPending(requestId);
    }
  }

  /**
   * 配置飞书消息路由：用户在飞书回复 → 匹配 requestId → resolve 本地 pending 或跨实例转发。
   */
  private setupFeishuRouting() {
    if (this.feishuRoutingSetup) return;
    this.feishuRoutingSetup = true;

    this.feishu.setOnReply(async (reply: FeishuInboundReply) => {
      const { parentId, text, chatId } = reply;
      const messageId = reply.messageId || '';
      const images = reply.images || [];
      const files = reply.files || [];
      // 文本、图片、文件任一非空都算有效反馈（此前只认文本，导致纯图片/文件被丢弃）
      if (!text && images.length === 0 && files.length === 0) return;

      // 斜杠命令优先于反馈路由：用户显式输入命令时不应被当成对某张卡片的回复或排队消息。
      // 大小写不敏感：手机输入法常自动把句首字母大写（/New），必须容错。
      if (/^\s*[/／](new|stop|model|cwd|help|projects)\b/i.test(text) && this.handleCliCommand(text, chatId)) return;

      if (parentId) {
        // 用户「回复」了某条卡片 → 用 parent_id 精确路由
        const reqId = this.feishu.resolveParent(parentId);
        if (reqId) {
          // 这张卡片是本实例发出的
          if (this.pendingRequests.has(reqId)) {
            this.submitFromFeishu(reqId, text, chatId, images, files, messageId);
          } else if (this.maybeStashForEndedCard(reqId, text, chatId, images, files, messageId)) {
            // 卡片刚超时、AI 正要续期重调 → 暂存续接到下一轮（超时未认领由 armStashExpiryNotice 回执）
          } else if (this.queueForEndedCard(reqId, text, chatId, images, files, messageId)) {
            // 忙时排队：AI 正忙（该项目无等待中的请求）→ 消息入队，等下一轮 feedback 自动送达
          } else {
            // 卡片是本实例发的，但请求确实已结束（已被回复 / 超时太久）→ 明确告知
            this.feishu.replyText(chatId, '这条反馈已经结束了（可能已超时或已被回复）。');
          }
        } else {
          // 不是本实例发出的卡片 → 广播给其他窗口的 server；无人认领必须回执，绝不静默丢弃
          const claimed = await this.broadcastFeishuInbound(parentId, text, chatId, images, files, messageId);
          if (!claimed) {
            this.feishu.replyToMessage(
              messageId || undefined,
              chatId,
              '⚠️ 这张卡片对应的反馈已结束或其所在窗口已关闭，消息未能送达。请回复最新的卡片，或等 AI 下次询问时再发。',
            );
          }
        }
        return;
      }

      // 无 parent_id（用户直接发消息，未指明卡片）→ 需要「全局视角」：
      // 飞书消息只会推给某一个窗口的 server，而各窗口各自维护 pending；只看本实例会误判
      // （每个窗口都以为自己唯一），导致多窗口时被随机一个窗口抢走。故先跨实例汇总全局再决策。
      const localPending = this.feishu.listPending();
      const remote = await this.queryRemotePending();
      const remoteCount = remote.reduce((n, r) => n + r.list.length, 0);
      const globalCount = localPending.length + remoteCount;

      if (globalCount === 0) {
        // 忙时排队优先：全局无人等待 = AI 大概率正在干活。定位到唯一的活跃项目窗口时
        // 直接把消息排队给它（含回执「已排队」），多个活跃窗口则引导用户回复对应卡片。
        // 复用上面 queryRemotePending 的扫描结果，避免二次全端口扫描。
        if (this.feishu.isQueueWhenBusy()) {
          const routed = await this.routeOrphanToQueue(text, chatId, images, files, messageId, remote);
          if (routed) return;
        }
        // 抢跑兜底：定位不到活跃窗口（或队列关闭）时，退回原有短暂存——很可能 AI 正要
        // 发起下一轮（卡片还没注册），等 pending 注册时立即兑现。
        // 关键：此刻没有任何 AI 在等待，绝不能给「✅ 已收到」回执——那是虚假承诺，会让用户
        // 误以为消息已被接收（实则 AI 这轮可能已结束、永远不会来认领，消息石沉大海）。
        // 回执只在「真正送达某个等待中的请求」时给（见 tryConsumeStash → submitFromFeishu）。
        this.stashInbound(text, chatId, images, files, messageId, McpFeedbackServer.STASH_TTL_MS);
      } else if (globalCount === 1) {
        if (localPending.length === 1) {
          // 唯一的等待就在本窗口 → 直接给
          this.submitFromFeishu(localPending[0].requestId, text, chatId, images, files, messageId);
        } else {
          // 唯一的等待在另一个窗口 → 转发让它认领
          const target = remote.find((r) => r.list.length === 1);
          if (target) this.forwardOrphan(target.port, text, chatId, images, files, messageId);
        }
      } else {
        // 多个等待并存 → 不猜。注意措辞：多个等待可能来自同一窗口的多个对话（用户实测
        // 「只开了一个窗口却提示多窗口」造成困惑），按「反馈请求」计数并列出项目名，
        // 引导用户去点想回复的那张卡片——回复哪张就精确回到哪个请求。
        const names = [
          ...localPending.map((p) => this.projectName(p.projectDir)),
          ...remote.flatMap((r) => r.list.map((x) => x.projectName)),
        ];
        this.feishu.replyText(
          chatId,
          `当前有 ${globalCount} 个反馈请求在等待（${names.join('、')}），可能来自不同窗口或同一窗口的多个对话，没法自动判断你要回复哪个。\n请在你想回复的那张卡片上点「回复」再发，回复哪张就送达哪个请求。`,
        );
      }
    });
  }

  /** 展开命令里的目录写法（支持 ~ 前缀和 Windows 盘符路径），非法/不存在返回 null */
  private expandDirToken(token: string): string | null {
    if (!token) return null;
    const looksLikePath =
      token.startsWith('/') || token.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(token);
    if (!looksLikePath) return null;
    const expanded = token.startsWith('~')
      ? path.join(os.homedir(), token.slice(1))
      : token;
    try {
      if (fs.statSync(expanded).isDirectory()) return expanded;
    } catch {
      // 不存在
    }
    return null;
  }

  /**
   * 处理飞书斜杠命令。返回是否已消费该消息。
   * - /new [目录或项目名] 任务描述：拉起 headless CLI 会话（非交互，spawn 前清 Max 残留）。
   *   工作目录刻意保持简单：显式指定 > 主目录，与当前开着哪些 IDE 窗口无关。
   * - /projects：列出 Cursor 打开过的项目路径（供手机上查路径 / 复制给 /new）
   * - /stop：终止运行中的 CLI 会话
   * - /model [模型id]：查看 / 设置 CLI 会话模型（持久化；无论选什么模型都强制 maxMode=false）
   */
  private handleCliCommand(rawText: string, chatId: string): boolean {
    // 输入容错：首尾空格（飞书入站已 trim，这里兜底；trim 同样覆盖全角空格 U+3000）；
    // 全角斜杠「／」归一化（中文输入法常见）；命令词大小写不敏感（手机输入法自动把句首
    // 大写成 /New）。任务正文原样保留。
    const text = rawText.trim().replace(/^／/, '/');

    if (/^\/help\b/i.test(text)) {
      this.feishu.replyText(
        chatId,
        '📖 命令一览（大小写、首尾空格都不敏感）\n\n' +
          '🚀 /new 任务描述\n' +
          '拉起一个全新的 AI 会话跑任务，电脑不用开着 Cursor（需已开启常驻服务）。\n' +
          '· 默认工作目录是主目录；可在任务前指定项目：\n' +
          '  /new /Users/me/proj 帮我修下测试\n' +
          '  /new crm-web 帮我修下测试（项目名唯一时自动匹配到完整路径）\n' +
          '· AI 需要沟通时会发反馈卡片，直接回复即可；同时只能跑一个会话\n\n' +
          '📁 /projects\n' +
          '列出 Cursor 打开过的项目路径（查路径 / 复制给 /new，也可直接用项目名）\n\n' +
          '🛑 /stop\n' +
          '终止运行中的 CLI 会话（任何窗口拉起的都能停）\n\n' +
          '🧠 /model [模型id]\n' +
          '查看 / 设置会话模型（持久化）\n\n' +
          '❓ /help\n' +
          '看这份帮助\n\n' +
          '💬 不带斜杠的消息照常作为反馈：回复某张卡片就送达那个请求，直接发送则给当前等待中的 AI。',
      );
      return true;
    }

    if (/^\/projects\b/i.test(text)) {
      const projects = this.cliLauncher.listProjects();
      if (!projects.length) {
        this.feishu.replyText(chatId, '没有找到 Cursor 打开过的项目记录。可以直接用绝对路径：/new /绝对路径 任务描述');
      } else {
        const lines = projects.slice(0, 20).map((p) => `· ${path.basename(p)} — ${p}`);
        this.feishu.replyText(
          chatId,
          `Cursor 打开过的项目（共 ${projects.length} 个${projects.length > 20 ? '，只列最近 20 个' : ''}）：\n` +
            lines.join('\n') +
            '\n\n用法：/new 项目名 任务描述（项目名唯一时直接匹配），或 /new 完整路径 任务描述',
        );
      }
      return true;
    }

    if (/^\/stop\b/i.test(text)) {
      if (this.cliLauncher.stop()) {
        this.feishu.replyText(chatId, '🛑 正在终止 CLI 会话…结束后我会再发一条收尾消息。');
      } else {
        this.feishu.replyText(chatId, '当前没有运行中的 CLI 会话。');
      }
      return true;
    }

    const mModel = text.match(/^\/model(?:\s+(\S+))?\s*$/i);
    if (mModel) {
      if (mModel[1]) {
        this.cliLauncher.writeSettings({ model: mModel[1] });
        this.feishu.replyText(chatId, `✅ CLI 模型已设为 ${mModel[1]}`);
      } else {
        this.feishu.replyText(
          chatId,
          `当前 CLI 模型：${this.cliLauncher.model()}\n设置：/model 模型id（例如 /model claude-fable-5-thinking-xhigh）`,
        );
      }
      return true;
    }

    // /cwd 已移除（工作目录简化为「/new 里显式指定，否则主目录」），给老用户指个路
    if (/^\/cwd\b/i.test(text)) {
      this.feishu.replyText(
        chatId,
        '/cwd 已移除。现在直接在 /new 里指定：/new 项目名或/绝对路径 任务描述；不指定就在主目录跑。\n用 /projects 可以查项目路径。',
      );
      return true;
    }

    // /model 带了多余参数（如 /model a b）：不落入反馈路由（用户明显在敲命令），回用法提示
    if (/^\/model\b/i.test(text)) {
      this.feishu.replyText(chatId, '参数不对。用法：/model 模型id（只接受一个参数，留空为查看当前模型）');
      return true;
    }

    const m = text.match(/^\/new\b\s*([\s\S]*)$/i);
    if (!m) return false;
    let task = (m[1] || '').trim();

    if (!task) {
      this.feishu.replyText(
        chatId,
        '用法：/new 任务描述（默认在主目录跑）\n' +
          '可选在任务前带工作目录（绝对路径或项目名）：\n' +
          '/new /Users/me/proj 帮我看下测试为什么挂了\n' +
          '/new my-blog 帮我看下测试为什么挂了\n' +
          '相关命令：/projects 查项目路径、/model 设模型、/stop 终止会话。',
      );
      return true;
    }

    if (this.cliLauncher.isRunning()) {
      this.feishu.replyText(
        chatId,
        '已有一个 CLI 会话在运行：' + this.cliLauncher.describe() + '\n发 /stop 可先终止它。',
      );
      return true;
    }

    // 工作目录刻意保持简单、与 IDE 窗口无关：命令里显式指定（路径或项目名）> 主目录。
    let cwd = os.homedir();
    const firstToken = task.split(/\s+/)[0];
    const explicitDir = this.expandDirToken(firstToken);
    if (explicitDir) {
      cwd = explicitDir;
      task = task.slice(firstToken.length).trim();
    } else {
      // 首词不是路径 → 试着当项目名匹配（Cursor 打开过的项目，按目录名精确匹配、忽略大小写）。
      // 唯一命中才采用；多个重名让用户用完整路径消歧；没命中就当作任务正文的第一个词。
      const matches = this.cliLauncher
        .listProjects()
        .filter((p) => path.basename(p).toLowerCase() === firstToken.toLowerCase());
      if (matches.length === 1) {
        cwd = matches[0];
        task = task.slice(firstToken.length).trim();
      } else if (matches.length > 1) {
        this.feishu.replyText(
          chatId,
          `有 ${matches.length} 个同名项目「${firstToken}」：\n` +
            matches.map((p) => `· ${p}`).join('\n') +
            '\n请用完整路径：/new 完整路径 任务描述',
        );
        return true;
      }
    }
    if (!task) {
      this.feishu.replyText(chatId, '只给了目录没给任务。用法：/new [目录或项目名] 任务描述');
      return true;
    }

    const err = this.cliLauncher.start(task, cwd, (result) =>
      this.onCliSessionDone(result, chatId),
    );
    if (err) {
      this.feishu.replyText(chatId, '❌ 拉起 CLI 会话失败：' + err);
    } else {
      this.feishu.replyText(
        chatId,
        '🚀 CLI 会话已拉起（非交互模式）\n' +
          `模型：${this.cliLauncher.model()}\n` +
          `工作目录：${cwd}\n` +
          `任务：${task.length > 100 ? task.slice(0, 100) + '…' : task}\n\n` +
          'AI 需要和你沟通时会发反馈卡片，直接回复卡片即可；发 /stop 可随时终止。',
      );
    }
    return true;
  }

  /**
   * 组装诊断报告（纯文本）。密钥严格脱敏：appSecret 绝不输出，appId 只留前 8 位。
   * 每个区块独立 try/catch，单块失败不影响整包导出。
   */
  private buildDiagnostics(): string {
    const sections: string[] = [];
    const add = (title: string, fn: () => string) => {
      let body: string;
      try {
        body = fn();
      } catch (e) {
        body = `（读取失败：${e}）`;
      }
      sections.push(`===== ${title} =====\n${body}`);
    };
    const maskId = (id: string) => (id.length > 8 ? id.slice(0, 8) + '***' : '***');
    const readJson = (file: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.cursor-feedback', file), 'utf-8'));
      } catch {
        return null;
      }
    };

    add('环境', () =>
      [
        `version: ${PKG_VERSION}`,
        `pid: ${process.pid}  uptimeSec: ${Math.round(process.uptime())}`,
        `platform: ${process.platform} ${os.release()} (${process.arch})`,
        `node: ${process.version}`,
        `daemonMode: ${this.daemonMode}`,
        `ownerWorkspace: ${this.ownerWorkspace || '(none)'}`,
        `hasCurrentRequest: ${this.currentRequest !== null}`,
      ].join('\n'),
    );

    add('飞书配置（脱敏）', () => {
      const cfg = readJson('feishu-config.json');
      if (!cfg) return '（未配置）';
      const safe = { ...cfg };
      if (typeof safe.appId === 'string') safe.appId = maskId(safe.appId);
      if ('appSecret' in safe) safe.appSecret = '***';
      return JSON.stringify(safe, null, 2);
    });

    add('飞书绑定（appId 脱敏）', () => {
      const bind = readJson('feishu-bind.json');
      if (!bind) return '（无）';
      return JSON.stringify(
        Object.fromEntries(Object.entries(bind).map(([k, v]) => [maskId(k), v])),
        null,
        2,
      );
    });

    add('通用设置 settings.json', () => JSON.stringify(readJson('settings.json') ?? '（无）'));
    add('CLI 设置 cli.json', () => JSON.stringify(readJson('cli.json') ?? '（无）'));
    add('CLI 会话锁', () => JSON.stringify(readJson('cli-session.lock') ?? '（无活跃会话）'));

    add('常驻服务状态', () => JSON.stringify(daemonStatus(), null, 2));

    add('最近日志（今天 + 昨天，尾部截断）', () => readRecentLogs());

    return `cursor-feedback 诊断报告  生成于 ${new Date().toISOString()}\n\n` + sections.join('\n\n') + '\n';
  }

  /** CLI 会话结束的收尾回执：把 agent 的最终输出（尾部）发回飞书 */
  private onCliSessionDone(result: CliSessionResult, chatId: string) {
    const mins = Math.max(1, Math.round(result.elapsedMs / 60000));
    let head: string;
    if (result.stopped) head = '🛑 CLI 会话已按你的要求终止';
    else if (result.timedOut) head = '⏱ CLI 会话超过时长上限，已被终止';
    else if (result.code === 0) head = '✅ CLI 会话已完成';
    else head = `⚠️ CLI 会话异常退出（code=${result.code}）`;

    let body = result.output || result.errorOutput || '（无输出）';
    // 飞书单条消息别太长：保留尾部（结论一般在最后）
    if (body.length > 1800) body = '…' + body.slice(body.length - 1800);
    this.feishu.replyText(chatId, `${head}（用时约 ${mins} 分钟）\n\n${body}`);
  }

  /** 当前生效的超时续期开关（优先 UI 开关 autoRetryOverride，未设置时回退环境变量/默认开启） */
  private effectiveAutoRetry(): boolean {
    return this.autoRetryOverride !== null
      ? this.autoRetryOverride
      : (process.env.MCP_AUTO_RETRY !== 'false');
  }

  private projectName(dir: string): string {
    return dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || dir;
  }

  /** 归一化路径用于跨进程/跨平台比对（统一斜杠、去尾斜杠、小写） */
  private normalizePath(p: string): string {
    return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  /**
   * 两个已归一化的路径是否属于同一窗口语境：相等，或一方是另一方的子目录。
   * 用于 owner 心跳匹配——AI 传的 project_directory 常是窗口工作区的子目录（monorepo 子包等），
   * 精确相等会漏判、心跳失配导致实例被防线 3 误杀。
   */
  private pathsRelated(a: string, b: string): boolean {
    if (!a || !b) return false;
    return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  }

  /** 飞书回复命中某 requestId → resolve 该 pending，并回执用户 */
  private submitFromFeishu(
    requestId: string,
    text: string,
    chatId: string,
    images: FeedbackResponse['images'] = [],
    attachedFiles: string[] = [],
    ackMessageId?: string,
  ) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.resolve({
      interactive_feedback: text,
      images,
      attachedFiles,
      // 用 pending 自己的归属窗口：共享进程多窗口时 currentRequest 可能已是另一窗口的请求
      project_directory: pending.projectDir || this.currentRequest?.projectDir || '',
    });
    this.pendingRequests.delete(requestId);
    this.feishu.clearPending(requestId);
    this.lastFeishuResolved = { id: requestId, at: Date.now() };
    debugLog(
      `Feedback resolved from Feishu for request: ${requestId} ` +
        `(images=${images.length}, files=${attachedFiles.length})`,
    );
    // 轻回执：给用户消息加 ✅ 表情，不产生新的未读消息（方案B）。
    // ackMessageId 为 undefined 表示回执已在别处完成（如抢跑暂存时已 react），跳过。
    if (ackMessageId !== undefined && chatId) {
      this.feishu.reactDone(ackMessageId || undefined, chatId);
    }
  }

  /**
   * 把飞书回复广播给其他窗口的 server（跨实例路由兜底）。
   * 返回是否有任一实例认领（handled）——无人认领时调用方必须回执用户，不能静默丢弃。
   */
  private broadcastFeishuInbound(
    parentId: string,
    text: string,
    chatId: string,
    images: FeedbackResponse['images'] = [],
    attachedFiles: string[] = [],
    messageId?: string,
  ): Promise<boolean> {
    const body = JSON.stringify({ parentId, text, chatId, images, attachedFiles, messageId });
    const posts: Array<Promise<boolean>> = [];
    for (let p = this.basePort; p < this.basePort + McpFeedbackServer.PORT_SCAN_RANGE; p++) {
      if (p === this.port) continue;
      posts.push(new Promise<boolean>((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: p,
            path: '/api/feishu/inbound',
            method: 'POST',
            timeout: 2000,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let resBody = '';
            res.on('data', (chunk) => { resBody += chunk.toString(); });
            res.on('end', () => {
              try {
                resolve(!!(JSON.parse(resBody) as { handled?: boolean }).handled);
              } catch {
                resolve(false);
              }
            });
          }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(body);
        req.end();
      }));
    }
    return Promise.all(posts).then((results) => results.some(Boolean));
  }

  /**
   * 向其他窗口的 server 查询各自的 pending 列表（仅项目名，用于全局视角判断 + 提示文案），
   * 以及实例归属窗口的存活状态（忙时排队用来定位「唯一活跃窗口」）。
   * 用于无 parent_id 的「无主消息」：飞书只推给一个窗口，需汇总全局才能正确决策。
   */
  private queryRemotePending(): Promise<
    Array<{ port: number; list: Array<{ projectName: string }>; ownerWorkspace: string | null; ownerAlive: boolean }>
  > {
    const ports: number[] = [];
    for (let p = this.basePort; p < this.basePort + McpFeedbackServer.PORT_SCAN_RANGE; p++) {
      if (p !== this.port) ports.push(p);
    }
    return Promise.all(ports.map((port) => this.fetchRemotePending(port)));
  }

  private fetchRemotePending(
    port: number,
  ): Promise<{ port: number; list: Array<{ projectName: string }>; ownerWorkspace: string | null; ownerAlive: boolean }> {
    return new Promise((resolve) => {
      const empty = { port, list: [], ownerWorkspace: null, ownerAlive: false };
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/api/feishu/pending', method: 'GET', timeout: 1500 },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const j = JSON.parse(body) as {
                list?: Array<{ projectName: string }>;
                ownerWorkspace?: string | null;
                ownerAlive?: boolean;
              };
              resolve({
                port,
                list: Array.isArray(j.list) ? j.list : [],
                ownerWorkspace: j.ownerWorkspace || null,
                ownerAlive: !!j.ownerAlive,
              });
            } catch {
              resolve(empty);
            }
          });
        },
      );
      req.on('error', () => resolve(empty));
      req.on('timeout', () => { req.destroy(); resolve(empty); });
      req.end();
    });
  }

  /** 把「无主消息」转发给全局唯一持有 pending 的那个远程窗口，让它认领提交 */
  private forwardOrphan(
    port: number,
    text: string,
    chatId: string,
    images: FeedbackResponse['images'] = [],
    attachedFiles: string[] = [],
    messageId?: string,
  ) {
    const body = JSON.stringify({ text, chatId, images, attachedFiles, messageId });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/feishu/inbound-orphan',
        method: 'POST',
        timeout: 2000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => { res.on('data', () => {}); res.on('end', () => {}); },
    );
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  }

  /**
   * 作废「同一窗口（projectDir）」此前残留的未决反馈请求（每次新请求进来时调用）。
   * 关键：绝不能动其他窗口 / agent 的 pending——多窗口或 AgentWindow 会复用同一个 MCP 进程，
   * 误清它们会让对方被当成超时而立即重试，多个 agent 互相取消，形成「取消风暴」（高频刷调用）。
   * 被作废者 resolve(null) → waitForFeedback 映射为 superseded，旧 await 安静结束、不重试；
   * 其 finally 因 id 不匹配也不会误清新请求。
   */
  private cancelStalePending(projectDir: string) {
    if (this.pendingRequests.size === 0) return;
    const owner = this.normalizePath(projectDir);
    for (const [reqId, pending] of this.pendingRequests) {
      if (this.normalizePath(pending.projectDir) !== owner) continue;
      // 用户显式暂停的等待不作废：暂停 = 用户明确表达「保住这轮、等我回来」，
      // 不是僵尸残留。同窗口新旧请求并存时，/api/feedback/current 按「未暂停优先」
      // 返回，active 的结束后暂停中的会重新回到面板，可恢复可提交。
      if (pending.paused) continue;
      clearTimeout(pending.timeout);
      pending.resolve(null); // → superseded：旧 await 安静结束，不触发重试
      this.feishu.clearPending(reqId);
      this.pendingRequests.delete(reqId);
    }
  }

  /**
   * 查找可 join 的「重复投递」等待，两级匹配：
   * 1) wire id 精确匹配：同一条 JSON-RPC 请求（同 id）还在等待 → 必是重复投递；
   * 2) 内容启发式：同窗口 + 同 summary + 同 timeout，且原请求仍在 pending（覆盖客户端
   *    重投时换了新 wire id 的情况）。
   * 内容启发式不设时间窗——旧实现的 90s 窗口被实测击穿（重投可晚至 3~8 分钟，无固定上限）。
   * 不设窗口是安全的：pending 仍存活 = 原调用尚未返回 = 同一会话不可能已合法开启新一轮；
   * 不同会话在同一窗口撞出一字不差的 summary + timeout 概率可忽略，即便撞上，
   * join（双方共享同一份回复）也远比 supersede（悄悄掐掉别人的等待）安全。
   */
  private findDuplicatePending(
    projectDir: string,
    summary: string,
    timeout: number,
    wireKey?: string,
  ): { id: string; via: 'wire id' | 'content'; waiters: Array<(outcome: WaitOutcome) => void> } | null {
    const owner = this.normalizePath(projectDir);
    for (const [id, pending] of this.pendingRequests) {
      if (wireKey !== undefined && pending.wireId === wireKey) {
        return { id, via: 'wire id', waiters: pending.waiters };
      }
      if (this.normalizePath(pending.projectDir) !== owner) continue;
      if (pending.request.summary !== summary) continue;
      if (pending.request.timeout !== timeout) continue;
      return { id, via: 'content', waiters: pending.waiters };
    }
    return null;
  }

  /**
   * 已结束请求的结果缓存（wire id → 当时的结果）：供「迟到的重复投递」精确重放。
   * 容量与时效都收紧（feedback 结果可能含 base64 图片，不能无限囤积）。
   */
  private settledByWire = new Map<string, { outcome: WaitOutcome; requestId: string; at: number }>();
  private static readonly SETTLED_WIRE_TTL_MS = 10 * 60 * 1000;
  private static readonly SETTLED_WIRE_MAX = 20;

  private rememberSettledWire(wireKey: string | undefined, outcome: WaitOutcome, requestId: string) {
    if (!wireKey) return;
    const now = Date.now();
    this.settledByWire.set(wireKey, { outcome, requestId, at: now });
    for (const [k, v] of this.settledByWire) {
      if (now - v.at > McpFeedbackServer.SETTLED_WIRE_TTL_MS) this.settledByWire.delete(k);
    }
    // Map 按插入序迭代，超限时先淘汰最早的
    while (this.settledByWire.size > McpFeedbackServer.SETTLED_WIRE_MAX) {
      const oldest = this.settledByWire.keys().next().value;
      if (oldest === undefined) break;
      this.settledByWire.delete(oldest);
    }
  }

  /**
   * 把等待结果翻译成 MCP 工具响应（主等待与重复投递 join 的等待共用同一段收尾语义）。
   */
  private outcomeToResult(outcome: WaitOutcome, requestId: string): {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  } {
    // 被同窗口/同进程的新一轮请求取代：安静结束，绝不能重试（否则多 agent 互相取消、忙等刷屏）。
    if (outcome.kind === 'superseded') {
      debugLog(`Request ${requestId} superseded by a newer request; ending this turn quietly`);
      return {
        content: [
          {
            type: 'text',
            text: '[SUPERSEDED] This feedback request was replaced by a newer interactive_feedback call (the same workspace started a new round, or another agent shares this MCP process). Do NOT call interactive_feedback again for this turn — just end your turn quietly. 【本反馈请求已被同窗口/同进程的新请求取代：不要再次调用 interactive_feedback，安静结束本轮，切勿重试。】',
          },
        ],
      };
    }

    if (outcome.kind === 'timeout') {
      debugLog('Feedback wait window elapsed without user input');
      // 超时续期开关：MCP_AUTO_RETRY=false 时关闭（超时即结束），默认开启（超时返回续期提醒）。
      // 关键：这里【绝不能】说成 "cancelled"——那会让 AI 误以为用户主动取消而结束对话，
      // 这正是“超时后 AI 直接收尾、不再续命”的根因。改为明确区分“超时 ≠ 取消”。
      const autoRetry = this.effectiveAutoRetry();
      const timeoutMessage = autoRetry
        ? '[TIMEOUT_KEEP_WAITING] No feedback was submitted within the wait window. This is a TIMEOUT, NOT a cancellation — the user is most likely still away from the keyboard. You MUST immediately call the interactive_feedback tool again with the same project_directory to keep waiting. Do NOT end the conversation, do NOT summarize the task as finished. Only stop calling it when the user EXPLICITLY tells you to stop. 【这是超时续期，并非用户取消：请立即用相同 project_directory 再次调用 interactive_feedback 继续等待，不要结束对话、不要当作任务完成。】'
        : '[TIMEOUT_END] No feedback was submitted within the wait window and timeout auto-continue is disabled (MCP_AUTO_RETRY=false). You may end this turn now. 【超时未收到反馈，且已关闭超时续期（MCP_AUTO_RETRY=false），可以结束本轮。】';
      return {
        content: [
          {
            type: 'text',
            text: timeoutMessage,
          },
        ],
      };
    }

    const result = outcome.data;

    debugLog(`Received feedback: ${result.interactive_feedback?.substring(0, 100)}...`);

    const contentItems: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

    // 构建反馈文本
    let feedbackText = '';

    // 添加文字反馈
    if (result.interactive_feedback) {
      feedbackText += `=== User Feedback ===\n${result.interactive_feedback}`;
    }

    // 添加附加文件路径
    if (result.attachedFiles && result.attachedFiles.length > 0) {
      debugLog(`Processing ${result.attachedFiles.length} attached files`);
      feedbackText += `\n\n=== Attached Files ===\n`;
      for (const filePath of result.attachedFiles) {
        feedbackText += `${filePath}\n`;
      }
      feedbackText += `\nPlease read the above files to understand the context.`;
    }

    if (feedbackText) {
      contentItems.push({
        type: 'text',
        text: feedbackText,
      });
    }

    // 添加图片
    if (result.images && result.images.length > 0) {
      debugLog(`Processing ${result.images.length} images`);
      for (const img of result.images) {
        contentItems.push({
          type: 'image',
          data: img.data,
          mimeType: this.getMimeType(img.name),
        });
      }
    }

    if (contentItems.length === 0) {
      contentItems.push({
        type: 'text',
        text: 'User did not provide any feedback.',
      });
    }

    return { content: contentItems };
  }

  /**
   * 等待用户反馈：注册 pending 并挂起，结果通过 waiters 广播——
   * 首个调用与后续 join 进来的重复投递调用都会收到同一份结果。
   */
  private waitForFeedback(request: FeedbackRequest, timeoutMs: number, wireKey?: string): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      const requestId = request.id;
      const projectDir = request.projectDir;
      const waiters: Array<(outcome: WaitOutcome) => void> = [resolve];
      // 广播给所有 waiter（splice 清空防重复触发：timeout 与 resolve 竞态时只结算一次）
      const settle = (outcome: WaitOutcome) => {
        for (const w of waiters.splice(0)) w(outcome);
      };

      const onTimeout = () => {
        debugLog(`Request ${requestId} timed out`);
        this.pendingRequests.delete(requestId);
        // 记录「刚超时」：续期空窗内的面板提交 / 旧卡片回复可续接到下一轮（顺手清理过期记录）
        this.recentlyTimedOut.set(requestId, { projectDir, at: Date.now() });
        for (const [id, v] of this.recentlyTimedOut) {
          if (Date.now() - v.at > McpFeedbackServer.REJOIN_TTL_MS * 4) this.recentlyTimedOut.delete(id);
        }
        // 飞书侧的清理统一交给 handleInteractiveFeedback 的 finally（clearPending），这里不再重复。
        settle({ kind: 'timeout' });
      };
      const timeout = setTimeout(onTimeout, timeoutMs);

      this.pendingRequests.set(requestId, {
        // resolve 包一层：沿用「外部 resolve(feedback) / resolve(null)」旧约定，
        // 但 null 一律映射为 superseded（被同进程新请求取代），绝不再走「超时重试」路径。
        resolve: (value: FeedbackResponse | null) => {
          settle(value === null ? { kind: 'superseded' } : { kind: 'feedback', data: value });
        },
        reject: () => settle({ kind: 'superseded' }),
        timeout,
        projectDir,
        onTimeout,
        deadline: Date.now() + timeoutMs,
        paused: false,
        remainingMs: timeoutMs,
        request,
        waiters,
        wireId: wireKey,
      });

      // 抢跑兑现：空窗期的面板提交（优先，用户显式点了发送）与飞书暂存消息，
      // 本轮 pending 一注册立即作为回复提交；最后是忙时队列里排队的追加消息
      this.tryConsumePanelStash(requestId);
      this.tryConsumeStash(requestId);
      this.tryConsumeQueue(requestId);
    });
  }

  /**
   * 暂停/恢复某个待反馈请求的超时倒计时（用户在面板点暂停按钮触发）。
   * 暂停 = 冻结真实计时器并记下剩余时间；恢复 = 用剩余时间重新起表。
   * 暂停期间 AI 一直挂在 interactive_feedback 调用上等待，正是期望行为（等同无限超时）。
   */
  private setPaused(requestId: string, paused: boolean): { ok: boolean; paused: boolean; remainingMs: number } {
    const p = this.pendingRequests.get(requestId);
    if (!p) return { ok: false, paused: false, remainingMs: 0 };
    if (paused && !p.paused) {
      clearTimeout(p.timeout);
      p.remainingMs = Math.max(0, p.deadline - Date.now());
      p.paused = true;
      debugLog(`Request ${requestId} countdown paused (${p.remainingMs}ms left)`);
    } else if (!paused && p.paused) {
      p.paused = false;
      p.deadline = Date.now() + p.remainingMs;
      p.timeout = setTimeout(p.onTimeout, p.remainingMs);
      debugLog(`Request ${requestId} countdown resumed (${p.remainingMs}ms left)`);
    }
    return {
      ok: true,
      paused: p.paused,
      remainingMs: p.paused ? p.remainingMs : Math.max(0, p.deadline - Date.now()),
    };
  }

  /** 指定请求的暂停态快照（随 /api/feedback/current 下发，供面板重建后恢复显示） */
  private getPauseStateFor(
    requestId: string | undefined,
  ): { requestId: string; paused: boolean; remainingMs: number } | null {
    if (!requestId) return null;
    const p = this.pendingRequests.get(requestId);
    if (!p) return null;
    return {
      requestId,
      paused: p.paused,
      remainingMs: p.paused ? p.remainingMs : Math.max(0, p.deadline - Date.now()),
    };
  }

  /**
   * 按窗口（workspace）从 pendingRequests 挑该窗口该看到的请求。
   * 修复「多窗口共用一个 MCP 进程时 currentRequest 单值槽互相覆盖、被覆盖的窗口面板
   * 显示不出自己的等待（只有飞书收到）」：每个窗口轮询时按自己的路径取自己的请求。
   * 多个匹配时：未暂停的优先（active 请求先服务）；同暂停态取最新——active 的结束后
   * 暂停中的会自然回到面板，用户可恢复。
   */
  private pickRequestForWorkspace(normalizedWs: string): FeedbackRequest | null {
    let best: { request: FeedbackRequest; paused: boolean } | null = null;
    for (const [, p] of this.pendingRequests) {
      if (!this.pathsRelated(this.normalizePath(p.projectDir), normalizedWs)) continue;
      if (!best) {
        best = p;
        continue;
      }
      if (best.paused !== p.paused) {
        if (best.paused) best = p;
        continue;
      }
      if (p.request.timestamp > best.request.timestamp) best = p;
    }
    return best ? best.request : null;
  }

  /**
   * 写入/合并抢跑暂存：短时间内连发多条（含图文拆条后超出合并窗口的）合并为一条，
   * 绝不让后一条覆盖前一条（旧实现会把第一条静默丢掉）。
   */
  private stashInbound(
    text: string,
    chatId: string,
    images: FeedbackResponse['images'],
    files: string[],
    messageId: string,
    ttlMs: number,
    forProjectDir?: string,
  ): void {
    const prev = this.stashedInbound;
    if (prev && Date.now() - prev.at <= prev.ttlMs && prev.chatId === chatId) {
      // 未过期的同会话暂存 → 合并追加，刷新时间与 TTL
      this.stashedInbound = {
        text: [prev.text, text].filter(Boolean).join('\n'),
        chatId,
        images: [...prev.images, ...images],
        files: [...prev.files, ...files],
        at: Date.now(),
        messageId: messageId || prev.messageId,
        ttlMs: Math.max(prev.ttlMs, ttlMs),
        forProjectDir: forProjectDir ?? prev.forProjectDir,
      };
    } else {
      this.stashedInbound = { text, chatId, images, files, at: Date.now(), messageId, ttlMs, forProjectDir };
    }
    this.armStashExpiryNotice();
  }

  /**
   * 用户回复了一张「刚超时」的卡片：超时续期开启时 AI 马上会重新发起下一轮，
   * 把回复暂存续接到下一轮，而不是回一句「已结束」把用户的内容丢掉。
   * 返回 true 表示已暂存（调用方无需再回执）。
   */
  private maybeStashForEndedCard(
    reqId: string,
    text: string,
    chatId: string,
    images: FeedbackResponse['images'],
    files: string[],
    messageId: string,
  ): boolean {
    const rt = this.recentlyTimedOut.get(reqId);
    if (!rt) return false; // 不是「刚超时」的请求（可能已被回复过，或结束太久）
    if (Date.now() - rt.at > McpFeedbackServer.REJOIN_TTL_MS) return false;
    if (!this.effectiveAutoRetry()) return false; // 续期关闭 → 不会有下一轮，别让用户空等
    // 同窗口已有新一轮在等 → 用户该回复新卡片，不做续接（避免旧回复窜入错误轮次）
    const owner = this.normalizePath(rt.projectDir);
    for (const [, pending] of this.pendingRequests) {
      if (this.normalizePath(pending.projectDir) === owner) return false;
    }
    debugLog(`Reply to recently timed-out card ${reqId}, stashing for next round`);
    this.stashInbound(text, chatId, images, files, messageId, McpFeedbackServer.REJOIN_TTL_MS, rt.projectDir);
    return true;
  }

  /**
   * 暂存后启动过期提示定时器：到 TTL 仍没被 AI 认领，就「回复」
   * 那条消息明确告知没送到、引导重发（不再静默丢弃，也不给虚假回执）。
   * 每来一条都重置，避免连发时多个定时器并存。
   */
  private armStashExpiryNotice(): void {
    if (this.stashExpiryTimer) clearTimeout(this.stashExpiryTimer);
    const ttl = this.stashedInbound?.ttlMs ?? McpFeedbackServer.STASH_TTL_MS;
    this.stashExpiryTimer = setTimeout(() => {
      this.stashExpiryTimer = null;
      const stash = this.stashedInbound;
      if (!stash) return; // 已被 tryConsumeStash 兑现
      this.stashedInbound = null;
      // 引用回复（锚定到最近这条，方便定位）。文案不带「这条/都/重复」等数量词——
      // 单条已断、多条全丢、第一条已送达后续丢，三种场景下数量词总有一种会误导。
      // 且引导「待 AI 回复后再重发」：AI 只有重新调起 feedback（即回复）时才会等待接收，
      // 此刻立即重发仍会落空。
      this.feishu.replyToMessage(
        stash.messageId,
        stash.chatId,
        '⚠️ 消息未能送达 AI（它可能正忙于上一轮任务，或这轮对话已结束）。需要的话请待 AI 回复后重新发送一次。',
      );
    }, ttl);
  }

  /**
   * 抢跑暂存兑现：若存在近期暂存的飞书消息，立即作为指定请求的回复提交。
   * 过期的暂存视为与当前任务无关，直接丢弃；带窗口限定的暂存只给对应窗口。
   */
  private tryConsumeStash(requestId: string): void {
    const stash = this.stashedInbound;
    if (!stash) return;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return; // 请求已不在（不能消费暂存，留给真正等待中的下一轮）
    // 带窗口限定的暂存（回复旧卡片的续接）只给同一窗口的新一轮，不给别的项目
    if (
      stash.forProjectDir &&
      this.normalizePath(stash.forProjectDir) !== this.normalizePath(pending.projectDir)
    ) {
      return;
    }
    this.stashedInbound = null;
    // 已被 AI 认领，取消「没送到」提示定时器
    if (this.stashExpiryTimer) {
      clearTimeout(this.stashExpiryTimer);
      this.stashExpiryTimer = null;
    }
    if (Date.now() - stash.at > stash.ttlMs) {
      debugLog('Stashed inbound expired, dropped');
      return;
    }
    debugLog(`Consuming stashed inbound for request: ${requestId}`);
    // 真正送达某个等待中的请求时，才给「✅ 送达回执」（传 messageId 触发 reactDone）。
    // 暂存阶段不再预先回执，避免「没人接却假装已收到」误导用户。
    this.submitFromFeishu(requestId, stash.text, stash.chatId, stash.images, stash.files, stash.messageId);
  }

  /**
   * 面板暂存兑现：用户在「刚超时、AI 正要续期重调」的空窗内点了提交，
   * 反馈已被 /api/feedback/submit 暂存，这里在下一轮注册时立即送达。
   */
  private tryConsumePanelStash(requestId: string): void {
    const stash = this.panelStash;
    if (!stash) return;
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    if (this.normalizePath(stash.projectDir) !== this.normalizePath(pending.projectDir)) return;
    this.panelStash = null;
    if (Date.now() - stash.at > McpFeedbackServer.REJOIN_TTL_MS) {
      debugLog('Panel stash expired, dropped');
      return;
    }
    debugLog(`Consuming panel stash for request: ${requestId}`);
    clearTimeout(pending.timeout);
    pending.resolve(stash.feedback);
    this.pendingRequests.delete(requestId);
    this.feishu.clearPending(requestId);
  }

  // ==================== 忙时消息队列 ====================

  /** 某项目空间当前是否有等待中的反馈请求（路径互为前缀视为同一窗口语境） */
  private hasPendingForProject(projectDir: string): boolean {
    const owner = this.normalizePath(projectDir);
    for (const [, p] of this.pendingRequests) {
      if (this.pathsRelated(this.normalizePath(p.projectDir), owner)) return true;
    }
    return false;
  }

  /** 队列里是否有属于某项目空间的排队消息（不看渠道开关：面板消息不受飞书队列开关约束） */
  private hasQueuedFor(projectDir: string): boolean {
    const owner = this.normalizePath(projectDir);
    return this.queuedInbound.some((q) =>
      this.pathsRelated(this.normalizePath(q.forProjectDir), owner),
    );
  }

  /** 某项目空间的排队消息快照（随 /api/feedback/current 下发给面板展示队列列表） */
  private queuedSnapshotFor(normalizedWs: string): Array<{
    id: string;
    at: number;
    source: 'feishu' | 'panel';
    text: string;
    images: number;
    files: number;
  }> {
    if (!normalizedWs) return [];
    return this.queuedInbound
      .filter((q) => this.pathsRelated(this.normalizePath(q.forProjectDir), normalizedWs))
      .map((q) => ({
        id: q.id,
        at: q.at,
        source: q.source,
        text: q.text,
        images: q.images.length,
        files: q.files.length,
      }));
  }

  /**
   * 撤回一条排队消息（面板队列列表的小叉触发）。
   * 飞书来源的消息同步回执「已撤回」，两边状态一致；面板消息撤掉后列表随轮询消失即回执。
   * 返回 false = 没找到（可能已被消费或过期），面板下一秒轮询自然对齐，无需特殊处理。
   */
  private removeQueuedById(id: string): boolean {
    const idx = this.queuedInbound.findIndex((q) => q.id === id);
    if (idx < 0) return false;
    const [item] = this.queuedInbound.splice(idx, 1);
    clearTimeout(item.expiryTimer);
    debugLog(`Queued message recalled (id=${id}, source=${item.source}, queueSize=${this.queuedInbound.length})`);
    if (item.source === 'feishu') {
      this.feishu.replyToMessage(
        item.messageId || undefined,
        item.chatId,
        '🗑️ 这条排队消息已在插件面板被撤回，不会送达 AI。',
      );
    }
    return true;
  }

  /**
   * 用户回复了一张「已结束」的卡片（不在超时续接窗口内）→ 忙时排队：
   * - 该项目已有新一轮在等 → 引导回复最新卡片（避免旧回复窜入错误轮次），视为已处理；
   * - 该项目没有等待中的请求（AI 正忙）→ 入队，等下一轮 feedback 自动送达。
   * 返回 true 表示已处理（排队或已引导），false 表示队列关闭 / 定位不到归属，走原有「已结束」回执。
   */
  private queueForEndedCard(
    reqId: string,
    text: string,
    chatId: string,
    images: FeedbackResponse['images'],
    files: string[],
    messageId: string,
  ): boolean {
    if (!this.feishu.isQueueWhenBusy()) return false;
    const cardProject = this.feishu.projectDirOf(reqId);
    if (!cardProject) return false;
    if (this.hasPendingForProject(cardProject)) {
      this.feishu.replyToMessage(
        messageId || undefined,
        chatId,
        '这张卡片的反馈已结束，且该项目有新的反馈卡片正在等待。请「回复」最新的那张卡片。',
      );
      return true;
    }
    this.enqueueInbound(text, chatId, images, files, messageId, cardProject);
    return true;
  }

  /**
   * 消息入队 + 回执用户「已排队」。每条消息带 60 分钟过期兜底：
   * 到点仍未被 AI 读取（对话可能已结束）→ 引用回复告知未送达，绝不静默丢弃。
   * 飞书与面板消息共用同一个队列（严格按到达顺序），但回执链路分渠道：
   * 飞书走引用回复/表情，面板消息没有推送通道，靠轮询下发的队列列表反映在/不在。
   */
  private enqueueInbound(
    text: string,
    chatId: string,
    images: FeedbackResponse['images'],
    files: string[],
    messageId: string,
    forProjectDir: string,
    source: 'feishu' | 'panel' = 'feishu',
  ): void {
    // 上限保护：挤出最老的一条并告知未送达
    while (this.queuedInbound.length >= McpFeedbackServer.QUEUE_MAX) {
      const dropped = this.queuedInbound.shift();
      if (!dropped) break;
      clearTimeout(dropped.expiryTimer);
      if (dropped.source === 'feishu') {
        this.feishu.replyToMessage(
          dropped.messageId || undefined,
          dropped.chatId,
          '⚠️ 排队消息过多，这条消息已被挤出队列、未送达 AI，请稍后重发。',
        );
      }
    }
    const item = {
      id: `q${Date.now()}_${++this.queueSeq}`,
      text,
      chatId,
      images,
      files,
      at: Date.now(),
      messageId,
      source,
      forProjectDir,
      expiryTimer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    item.expiryTimer = setTimeout(() => {
      const idx = this.queuedInbound.indexOf(item);
      if (idx < 0) return; // 已被消费
      this.queuedInbound.splice(idx, 1);
      if (item.source === 'feishu') {
        this.feishu.replyToMessage(
          item.messageId || undefined,
          item.chatId,
          '⚠️ 这条排队消息等了 60 分钟仍未被 AI 读取（对话可能已结束），未能送达。需要的话请在 AI 下次询问时重发。',
        );
      }
    }, McpFeedbackServer.QUEUE_TTL_MS);
    item.expiryTimer.unref?.();
    this.queuedInbound.push(item);
    debugLog(
      `Inbound queued for busy AI (source=${source}, project=${forProjectDir}, queueSize=${this.queuedInbound.length})`,
    );
    if (source === 'feishu') {
      this.feishu.replyToMessage(
        messageId || undefined,
        chatId,
        `🤖 AI 正在工作中，这条消息已排队，将在「${this.projectName(forProjectDir)}」当前任务完成后自动读取。`,
      );
    }
  }

  /**
   * 队列兑现：新一轮 pending 注册时，把属于该项目空间的所有排队消息合并成一次反馈送达，
   * 正文附「任务期间追加」提示头，并给每条排队消息补 ✅ 送达回执。
   */
  private tryConsumeQueue(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    if (this.queuedInbound.length === 0) return;
    const owner = this.normalizePath(pending.projectDir);
    const matched = this.queuedInbound.filter((q) =>
      this.pathsRelated(this.normalizePath(q.forProjectDir), owner),
    );
    if (matched.length === 0) return;
    this.queuedInbound = this.queuedInbound.filter((q) => !matched.includes(q));
    for (const m of matched) clearTimeout(m.expiryTimer);

    const two = (n: number) => String(n).padStart(2, '0');
    const fmt = (at: number) => {
      const d = new Date(at);
      return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
    };
    const lines = matched.map((m) => {
      const body = m.text || (m.images.length || m.files.length ? '[图片/附件]' : '');
      return `[${fmt(m.at)}] ${body}`;
    });
    const text =
      '[QUEUED_MESSAGES] 以下是用户在你执行上一轮任务期间「追加」发送的消息（当时你正忙，消息已排队暂存）。' +
      '注意：这些内容不是对你最新一轮工作摘要的回复，请结合任务上下文阅读并处理；' +
      '如与你摘要中的询问冲突，以用户追加内容为准。本次的 summary 用户并没有收到，如有必要可在下次带上。' +
      '处理完后照常调用 interactive_feedback 继续对话。\n\n' +
      `=== 追加消息（${matched.length} 条）===\n` +
      lines.join('\n\n');

    debugLog(`Consuming ${matched.length} queued message(s) for request: ${requestId}`);
    clearTimeout(pending.timeout);
    pending.resolve({
      interactive_feedback: text,
      images: matched.flatMap((m) => m.images),
      attachedFiles: matched.flatMap((m) => m.files),
      project_directory: pending.projectDir,
    });
    this.pendingRequests.delete(requestId);
    this.feishu.clearPending(requestId);
    // 标记为「飞书渠道 resolve」：插件面板据此重置，避免对着已消失的请求提交
    this.lastFeishuResolved = { id: requestId, at: Date.now() };
    // 送达回执：给每条飞书排队消息补 ✅ 表情（面板消息没有回执通道，
    // 其送达状态由轮询下发的队列列表体现——消费后列表随即清空）
    for (const m of matched) {
      if (m.source === 'feishu') {
        this.feishu.reactDone(m.messageId || undefined, m.chatId);
      }
    }
  }

  /** 「我的窗口」是否仍活着（无插件 host 无从判定，视为活跃） */
  private isOwnerAlive(): boolean {
    if (!this.everOwnerPolled) return true;
    return Date.now() - this.lastOwnerPollTime <= McpFeedbackServer.OWNER_IDLE_MS;
  }

  /**
   * 「无主消息」的忙时排队路由：全局无人等待时，汇总所有实例的活跃项目窗口——
   * - 恰好 1 个 → 消息排队给它（本地直接入队；远程实例经 /api/feishu/enqueue 转发）；
   * - 多个 → 回执引导用户回复对应项目的卡片（回复旧卡片也会正确排队到该项目）；
   * - 0 个 → 返回 false，调用方退回原有短暂存兜底。
   */
  private async routeOrphanToQueue(
    text: string,
    chatId: string,
    images: FeedbackResponse['images'],
    files: string[],
    messageId: string,
    remotes: Array<{ port: number; ownerWorkspace: string | null; ownerAlive: boolean }>,
  ): Promise<boolean> {
    const candidates: Array<{ port: number | null; workspace: string }> = [];
    if (this.ownerWorkspace && this.isOwnerAlive()) {
      candidates.push({ port: null, workspace: this.ownerWorkspace });
    }
    for (const r of remotes) {
      if (r.ownerAlive && r.ownerWorkspace) {
        candidates.push({ port: r.port, workspace: r.ownerWorkspace });
      }
    }
    // 按 workspace 去重（同窗口多对话共用/多实例只算一个活跃窗口；本地优先）
    const seen = new Set<string>();
    const uniq: Array<{ port: number | null; workspace: string }> = [];
    for (const c of candidates) {
      const key = this.normalizePath(c.workspace);
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(c);
    }

    if (uniq.length === 1) {
      const target = uniq[0];
      if (target.port === null) {
        this.enqueueInbound(text, chatId, images, files, messageId, target.workspace);
        return true;
      }
      return this.forwardEnqueue(target.port, text, chatId, images, files, messageId);
    }
    if (uniq.length > 1) {
      const names = uniq.map((c) => this.projectName(c.workspace));
      this.feishu.replyToMessage(
        messageId || undefined,
        chatId,
        `当前有 ${uniq.length} 个项目窗口在工作（${names.join('、')}），没法判断这条消息要发给谁。\n` +
          '请「回复」你要发送的那个项目的卡片（旧卡片也行），消息会排队到对应项目。',
      );
      return true;
    }
    return false;
  }

  /** 把无主消息转发给远程实例排队（远程会自己入队并回执用户）。返回是否排队成功 */
  private forwardEnqueue(
    port: number,
    text: string,
    chatId: string,
    images: FeedbackResponse['images'],
    files: string[],
    messageId: string,
  ): Promise<boolean> {
    const body = JSON.stringify({ text, chatId, images, attachedFiles: files, messageId });
    return new Promise<boolean>((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/feishu/enqueue',
          method: 'POST',
          timeout: 2000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          let resBody = '';
          res.on('data', (chunk) => { resBody += chunk.toString(); });
          res.on('end', () => {
            try {
              resolve(!!(JSON.parse(resBody) as { queued?: boolean }).queued);
            } catch {
              resolve(false);
            }
          });
        },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(body);
      req.end();
    });
  }

  /**
   * 处理获取系统信息请求
   */
  private handleGetSystemInfo(): {
    content: Array<{ type: string; text: string }>;
  } {
    const systemInfo = {
      platform: process.platform,
      nodeVersion: process.version,
      arch: process.arch,
      hostname: os.hostname(),
      interfaceType: 'VS Code Extension',
      mcpServerPort: this.port,
      pid: process.pid,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(systemInfo, null, 2),
        },
      ],
    };
  }

  /**
   * 根据文件名获取 MIME 类型
   */
  private getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      default:
        return 'image/png';
    }
  }

  /**
   * 生成唯一的请求 ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * 检查端口是否被我们的 MCP Server 占用，如果是则请求关闭
   */
  private async checkAndCleanPort(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/api/health',
          method: 'GET',
          timeout: 1000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const health = JSON.parse(data);
              if (health.status === 'ok') {
                debugLog(`Found existing MCP Server on port ${port}, requesting shutdown...`);
                // 请求旧服务器关闭
                this.requestShutdown(port).then(() => {
                  resolve(true);
                }).catch(() => {
                  resolve(false);
                });
              } else {
                resolve(false);
              }
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  /**
   * 请求旧的 MCP Server 关闭
   */
  private async requestShutdown(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/api/shutdown',
          method: 'POST',
          timeout: 3000,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            debugLog(`Shutdown request sent to port ${port}`);
            // 等待旧进程退出
            setTimeout(resolve, 500);
          });
        }
      );
      req.on('error', () => {
        // 旧服务器可能已经关闭
        setTimeout(resolve, 200);
      });
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Shutdown request timeout'));
      });
      req.end();
    });
  }

  /**
   * 启动 HTTP 服务器，用于与 VS Code 插件通信
   */
  private startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // 包裹整个请求处理逻辑，防止异常导致进程崩溃
        try {
          // 任何来自插件的 HTTP 请求都视为 Cursor 仍存活的心跳（供 watchdog 判定）
          this.lastActivityTime = Date.now();

          // 不设置 CORS 头：本地 API 仅供本插件（Node http 客户端，不受同源策略限制）调用。
          // 去掉 Access-Control-Allow-Origin: * 后，同机浏览器里的恶意网页无法跨域读取
          // /api/feedback/current（可能含 AI summary 中的代码），靠浏览器同源策略兜底。
          if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
          }

          // 获取当前反馈请求
          if (req.method === 'GET' && req.url?.startsWith('/api/feedback/current')) {
          // autoRetry 不再从轮询 query 同步（曾致多窗口互相覆盖、抖动）：
          // 改由 POST /api/settings/autoRetry 广播 + 磁盘真相源，poll 只回读做 UI 回显。
          let pollWs = '';
          try {
            const u = new URL(req.url, 'http://127.0.0.1');
            // 「我的窗口」心跳：仅当轮询带的 workspace 匹配本实例归属时刷新。
            // 别的活跃窗口对全端口的扫描虽刷 lastActivityTime，但 workspace 不匹配、不刷此字段，
            // 故已关窗口的残留 server 不会被别人续命，可被 watchdog / 僵尸自检识别。
            // 匹配放宽为「路径互为前缀」：AI 传的 project_directory 可能是窗口工作区的子目录。
            // 命中即确认 owner 身份（ownerConfirmed），此后 owner 不再被后续调用改写。
            const ws = this.normalizePath(u.searchParams.get('workspace') || '');
            pollWs = ws;
            if (ws && this.ownerWorkspace && this.pathsRelated(ws, this.ownerWorkspace)) {
              this.lastOwnerPollTime = Date.now();
              this.everOwnerPolled = true;
              this.ownerConfirmed = true;
            }
          } catch {
            // 忽略解析错误
          }
          // 按窗口挑请求：多窗口/多对话共用本进程时各窗口各看各的等待，互不覆盖。
          // 不带 workspace（无工作区窗口 / 旧版插件）时回退全局 currentRequest 老行为。
          const chosen = pollWs ? this.pickRequestForWorkspace(pollWs) : (this.currentRequest || null);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // 返回该窗口的请求、ownerWorkspace、startTime，以及当前生效的 autoRetry（供 UI 初始同步）
          res.end(JSON.stringify({
            request: chosen,
            ownerWorkspace: this.ownerWorkspace,
            startTime: this.startTime,
            autoRetry: this.autoRetryOverride !== null ? this.autoRetryOverride : (process.env.MCP_AUTO_RETRY !== 'false'),
            feishu: this.feishu.getStatus(),
            feishuResolvedId: (this.lastFeishuResolved && Date.now() - this.lastFeishuResolved.at < 30000) ? this.lastFeishuResolved.id : null,
            pause: this.getPauseStateFor(chosen?.id),
            // 该窗口的忙时排队消息快照（飞书 + 面板同队列），供面板展示队列列表
            queued: this.queuedSnapshotFor(pollWs),
          }));
          return;
        }

        // 面板忙时排队：AI 正忙（该项目无等待中的请求）时，把面板消息排进忙时队列，
        // 与飞书消息共用同一队列（按到达顺序），下一轮 interactive_feedback 合并送达
        if (req.method === 'POST' && req.url === '/api/feedback/enqueue') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { text, images, attachedFiles, projectDir } = JSON.parse(body) as {
                text: string;
                images?: FeedbackResponse['images'];
                attachedFiles?: string[];
                projectDir?: string;
              };
              if (!projectDir) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ queued: false, reason: 'projectDir required' }));
                return;
              }
              // 忙时排队是全局开关（面板 UI 已隐藏排队入口，这里兜底防竞态）
              if (!this.feishu.isQueueWhenBusy()) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ queued: false, reason: 'disabled' }));
                return;
              }
              // 该项目有等待中的请求 → 不该排队，面板应直接提交（正常轮询下一秒就会显示该请求）
              if (this.hasPendingForProject(projectDir)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ queued: false, reason: 'pending' }));
                return;
              }
              this.enqueueInbound(text || '', '', images || [], attachedFiles || [], '', projectDir, 'panel');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ queued: true }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ queued: false, reason: 'invalid body' }));
            }
          });
          return;
        }

        // 撤回排队消息：面板队列列表的删除按钮触发，按队列项 id 定位。
        // 飞书来源的消息由 removeQueuedById 同步回执，保证两边状态一致
        if (req.method === 'POST' && req.url === '/api/feedback/queue/remove') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { id } = JSON.parse(body) as { id?: string };
              const removed = !!id && this.removeQueuedById(id);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ removed }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ removed: false }));
            }
          });
          return;
        }

        // 提交反馈
        if (req.method === 'POST' && req.url === '/api/feedback/submit') {
          let body = '';
          req.on('data', chunk => {
            body += chunk.toString();
          });
          req.on('end', () => {
            try {
              const data = JSON.parse(body) as { requestId: string; feedback: FeedbackResponse };
              const { requestId, feedback } = data;
              
              debugLog(`Received feedback submission for request: ${requestId}`);
              
              const pending = this.pendingRequests.get(requestId);
              const recentTimeout = this.recentlyTimedOut.get(requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                pending.resolve(feedback);
                this.pendingRequests.delete(requestId);
                // 飞书侧清理同样交给 finally（clearPending）统一处理，这里不再重复。
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
              } else if (
                recentTimeout &&
                this.effectiveAutoRetry() &&
                Date.now() - recentTimeout.at <= McpFeedbackServer.REJOIN_TTL_MS
              ) {
                // 提交撞上「刚超时、AI 正要续期重调」的空窗：暂存并在下一轮注册时立即送达，
                // 不再报 "Request not found" 把用户刚敲的反馈打回去
                debugLog(`Request ${requestId} timed out moments ago; queueing panel feedback for next round`);
                this.panelStash = { feedback, projectDir: recentTimeout.projectDir, at: Date.now() };
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, queued: true }));
              } else {
                debugLog(`Request ${requestId} not found`);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request not found' }));
              }
            } catch (error) {
              debugLog(`Invalid request body: ${error}`);
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid request body' }));
            }
          });
          return;
        }

        // 配置飞书（来自插件 UI；凭证未变只补 chatId，变了则重建长连接）
        // 扫码一键创建飞书应用：启动 Device Grant 流程并返回待扫码链接（等二维码就绪才响应）
        if (req.method === 'POST' && req.url === '/api/feishu/register/start') {
          this.feishu.startRegister().then((state) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state));
          }).catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: 'internal' }));
          });
          return;
        }

        // 扫码创建流程状态（插件轮询直到 success / error）
        if (req.method === 'GET' && req.url === '/api/feishu/register/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.feishu.getRegisterState()));
          return;
        }

        // 取消进行中的扫码创建流程（用户关闭设置弹窗）
        if (req.method === 'POST' && req.url === '/api/feishu/register/cancel') {
          this.feishu.cancelRegister();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'POST' && req.url === '/api/feishu/config') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            (async () => {
              try {
                const cfg = JSON.parse(body) as FeishuConfig;
                // 凭证以磁盘为全局真相源：用户改/删 → 持久化（touched=true）+ configure。
                // 多窗口下插件会把同一份 POST 给所有 server，各自写同一磁盘文件、行为一致；
                // 不再回退 env——用户主动清空就是空（touched 标记让重启后也尊重，不被 env 复活）。
                this.feishu.writePersistedConfig({
                  appId: cfg.appId || '',
                  appSecret: cfg.appSecret || '',
                  enabled: cfg.enabled,
                  ackReaction: cfg.ackReaction,
                  queueWhenBusy: cfg.queueWhenBusy,
                  touched: true,
                });
                await this.feishu.configure(cfg);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, status: this.feishu.getStatus() }));
              } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid config' }));
              }
            })();
          });
          return;
        }

        // 暂停/恢复倒计时（来自插件 UI 的暂停按钮）
        if (req.method === 'POST' && req.url === '/api/feedback/pause') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { requestId, paused } = JSON.parse(body) as { requestId?: string; paused?: boolean };
              if (!requestId || typeof paused !== 'boolean') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'requestId and paused are required' }));
                return;
              }
              const result = this.setPaused(requestId, paused);
              if (result.ok) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, paused: result.paused, remainingMs: result.remainingMs }));
              } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request not found' }));
              }
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid body' }));
            }
          });
          return;
        }

        // 超时续期开关（来自插件 UI；磁盘做真相源，跨窗口/重启一致；不再走轮询 query）
        if (req.method === 'POST' && req.url === '/api/settings/autoRetry') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { autoRetry } = JSON.parse(body) as { autoRetry?: boolean };
              if (typeof autoRetry === 'boolean') {
                this.autoRetryOverride = autoRetry;
                this.writePersistedSettings({ autoRetry });
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, autoRetry: this.autoRetryOverride }));
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid body' }));
            }
          });
          return;
        }

        // 解除飞书绑定（用户「删绑定」后重新发消息即可重新绑定）
        if (req.method === 'POST' && req.url === '/api/feishu/unbind') {
          this.feishu.unbind();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, status: this.feishu.getStatus() }));
          return;
        }

        // 常驻守护：状态查询 / 安装 / 卸载（供插件面板「常驻服务」开关调用）
        if (req.method === 'GET' && req.url === '/api/daemon/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...daemonStatus(), currentVersion: PKG_VERSION }));
          return;
        }
        if (req.method === 'POST' && (req.url === '/api/daemon/install' || req.url === '/api/daemon/uninstall')) {
          const isInstall = req.url === '/api/daemon/install';
          try {
            if (isInstall && !daemonSupported()) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `平台 ${process.platform} 暂不支持常驻守护` }));
              return;
            }
            const status = isInstall ? installDaemon() : uninstallDaemon();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, ...status, currentVersion: PKG_VERSION }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }

        // 跨实例转发的飞书回复（由其他窗口的 server 广播过来）
        if (req.method === 'POST' && req.url === '/api/feishu/inbound') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { parentId, text, chatId, images, attachedFiles, messageId } = JSON.parse(body) as {
                parentId: string | null;
                text: string;
                chatId: string;
                images?: FeedbackResponse['images'];
                attachedFiles?: string[];
                messageId?: string;
              };
              const reqId = this.feishu.resolveParent(parentId);
              if (reqId && this.pendingRequests.has(reqId)) {
                this.submitFromFeishu(reqId, text, chatId, images || [], attachedFiles || [], messageId || '');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ handled: true }));
              } else if (
                reqId &&
                this.maybeStashForEndedCard(reqId, text, chatId, images || [], attachedFiles || [], messageId || '')
              ) {
                // 本实例的卡片刚超时 → 暂存续接下一轮，向广播方声明已认领（未送达时由过期提示回执）
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ handled: true }));
              } else if (
                reqId &&
                this.queueForEndedCard(reqId, text, chatId, images || [], attachedFiles || [], messageId || '')
              ) {
                // 本实例的卡片、请求已结束且 AI 正忙 → 消息已排队（或已引导回复新卡片）
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ handled: true }));
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ handled: false }));
              }
            } catch {
              res.writeHead(400);
              res.end('{}');
            }
          });
          return;
        }

        // 查询本实例当前 pending 列表（供其他窗口做「全局视角」汇总；只暴露项目名）
        if (req.method === 'GET' && req.url === '/api/feishu/pending') {
          // 僵尸自检：本实例曾被自己窗口插件轮询，但已久未收到（只剩别的窗口在扫端口）→ 我的窗口已关，
          // 不再上报 pending，避免污染全局计数（用户反馈的「没开两个窗口却显示 2 个同名」即源于此）。
          const ownerGone =
            this.everOwnerPolled &&
            Date.now() - this.lastOwnerPollTime > McpFeedbackServer.OWNER_IDLE_MS;
          const list = ownerGone
            ? []
            : this.feishu.listPending().map((p) => ({ projectName: this.projectName(p.projectDir) }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // ownerWorkspace / ownerAlive：供其他实例的忙时排队路由定位「活跃项目窗口」
          res.end(JSON.stringify({
            count: list.length,
            list,
            ownerWorkspace: this.ownerWorkspace,
            ownerAlive: !!this.ownerWorkspace && !ownerGone,
          }));
          return;
        }

        // 接收「无主消息」转发：仅当本实例恰好持有唯一 pending 时认领提交
        if (req.method === 'POST' && req.url === '/api/feishu/inbound-orphan') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { text, chatId, images, attachedFiles, messageId } = JSON.parse(body) as {
                text: string;
                chatId: string;
                images?: FeedbackResponse['images'];
                attachedFiles?: string[];
                messageId?: string;
              };
              if (this.feishu.pendingCount() === 1) {
                const only = this.feishu.theOnlyPendingId();
                if (only) {
                  this.submitFromFeishu(only, text, chatId, images || [], attachedFiles || [], messageId || '');
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ claimed: true }));
                  return;
                }
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ claimed: false }));
            } catch {
              res.writeHead(400);
              res.end('{}');
            }
          });
          return;
        }

        // 接收「无主消息」的忙时排队转发：本实例是全局唯一活跃窗口时，把消息排进本实例队列
        // （入队与「已排队」回执都由本实例完成，转发方只关心 queued 结果）
        if (req.method === 'POST' && req.url === '/api/feishu/enqueue') {
          let body = '';
          req.on('data', (chunk) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const { text, chatId, images, attachedFiles, messageId } = JSON.parse(body) as {
                text: string;
                chatId: string;
                images?: FeedbackResponse['images'];
                attachedFiles?: string[];
                messageId?: string;
              };
              if (this.feishu.isQueueWhenBusy() && this.ownerWorkspace) {
                this.enqueueInbound(
                  text, chatId, images || [], attachedFiles || [], messageId || '', this.ownerWorkspace,
                );
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ queued: true }));
              } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ queued: false }));
              }
            } catch {
              res.writeHead(400);
              res.end('{}');
            }
          });
          return;
        }

        // 诊断包：版本/环境/配置（脱敏）/守护状态/会话锁 + 最近日志尾部，纯文本一把梭。
        // 插件面板「导出诊断包」按钮请求这里；轻量起见不打 zip，一个 txt 就够排查。
        if (req.method === 'GET' && req.url === '/api/diagnostics') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(this.buildDiagnostics());
          return;
        }

        // 健康检查
        if (req.method === 'GET' && req.url === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'ok', 
            version: PKG_VERSION,
            hasCurrentRequest: this.currentRequest !== null,
            pid: process.pid,
          }));
          return;
        }

        // 关闭服务器（用于新进程替换旧进程）
        if (req.method === 'POST' && req.url === '/api/shutdown') {
          debugLog('Received shutdown request from new MCP Server instance');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'Shutting down...' }));
          
          // 延迟关闭，确保响应已发送
          setTimeout(() => {
            this.stop();
            process.exit(0);
          }, 100);
          return;
        }

          res.writeHead(404);
          res.end('Not Found');
        } catch (error) {
          debugLog(`HTTP request error: ${error}`);
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          } catch {
            // 响应可能已经发送，忽略
          }
        }
      });

      this.httpServer.on('error', async (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // 端口被占用，使用下一个端口（不关闭旧的 MCP Server，支持多项目独立运行）。
          // 限制在扫描范围内：超出则放弃，避免 server 端口跑到插件扫描不到的区间导致失联。
          if (this.port - this.basePort >= McpFeedbackServer.PORT_SCAN_RANGE - 1) {
            reject(new Error(`No free port in scan range ${this.basePort}-${this.basePort + McpFeedbackServer.PORT_SCAN_RANGE - 1}`));
            return;
          }
          debugLog(`Port ${this.port} is already in use, trying next port...`);
          this.httpServer?.close();
          this.port++;
          this.startHttpServer().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(this.port, '127.0.0.1', () => {
        debugLog(`HTTP Server listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * 从 mcp.json 的 env 读取飞书默认配置。
   * 服务于「没有 webview 面板」的 MCP host（如 Claude Desktop / CLI）：它们无法用插件 UI 配飞书，
   * 只能在 mcp.json 里配 FEISHU_*。优先级：插件 UI（非空凭证）> 这里的 env > 代码默认（开关全开）。
   */
  /** 读取持久化的 server 设置（无文件返回 null）。 */
  private readPersistedSettings(): { autoRetry?: boolean } | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsStorePath, 'utf-8'));
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  /** 持久化 server 设置到磁盘（merge 写入，跨进程共享、重启不丢）。 */
  private writePersistedSettings(patch: { autoRetry?: boolean }): void {
    try {
      const cur = this.readPersistedSettings() || {};
      const next = { ...cur, ...patch };
      fs.mkdirSync(path.dirname(this.settingsStorePath), { recursive: true });
      fs.writeFileSync(this.settingsStorePath, JSON.stringify(next), 'utf-8');
    } catch {
      // 持久化失败不影响运行
    }
  }

  private readFeishuEnvConfig(): FeishuConfig | null {
    const appId = (process.env.FEISHU_APP_ID || '').trim();
    const appSecret = (process.env.FEISHU_APP_SECRET || '').trim();
    if (!appId || !appSecret) return null;
    return {
      appId,
      appSecret,
      enabled: process.env.FEISHU_ENABLED !== 'false',
      ackReaction: process.env.FEISHU_ACK !== 'false',
      queueWhenBusy: process.env.FEISHU_QUEUE !== 'false',
    };
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    try {
      debugLog('Starting MCP Feedback Server...');
      
      // 启动 HTTP 服务器
      await this.startHttpServer();

      // 飞书凭证优先级：用户在面板配过（磁盘持久化、跨窗口共享、含主动清空）> mcp.json env > 不启用。
      // 磁盘有 touched 记录就尊重它（哪怕凭证为空 = 用户主动清空，也不被 env 复活）；
      // 没碰过才回退 env（无面板的 host 靠 env 启用）。
      const persisted = this.feishu.readPersistedConfig();
      if (persisted && persisted.touched) {
        this.feishu.configure(persisted).catch(() => {});
      } else {
        const envFeishu = this.readFeishuEnvConfig();
        if (envFeishu) {
          this.feishu.configure(envFeishu).catch(() => {});
        }
      }

      // 超时续期开关同款优先级：磁盘（UI 改过、跨窗口共享）> env MCP_AUTO_RETRY > 默认开。
      const settings = this.readPersistedSettings();
      if (settings && typeof settings.autoRetry === 'boolean') {
        this.autoRetryOverride = settings.autoRetry;
      }

      if (this.daemonMode) {
        // 守护模式：没有 stdio 客户端（launchd/计划任务拉起，stdin 是 /dev/null），
        // 不连 MCP 传输、不装 stdin 退出钩子、不开看门狗（父进程本来就是 launchd）。
        // 顺带启动防睡眠：锁屏后手机随时能唤起（仅接电源时生效，不偷耗电池）。
        if (process.env.CURSOR_FEEDBACK_KEEP_AWAKE !== 'false') {
          this.keepAwake.start();
        }
        debugLog(`Daemon mode started (v${PKG_VERSION}), Feishu bridge + /new launcher only`);
        return;
      }

      // 启动 MCP stdio 传输
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      // stdio 关闭（Cursor reload / 关窗 / 重启该 MCP）→ 立即退出，避免旧进程残留堆积
      transport.onclose = () => {
        debugLog('stdio transport closed, exiting...');
        this.stop();
        setTimeout(() => process.exit(0), 100);
      };

      // 启动看门狗兜底退出（防止 Cursor 关闭后进程残留 / CPU 占满）
      this.startWatchdog();
      
      debugLog('MCP Server started successfully');
      debugLog('Waiting for tool calls from AI agent...');

      // 守护自动升级：本进程经 npx @latest 拉起、必然是最新版；发现已装守护版本落后
      // 就静默重装（拷贝新包 + 重启守护），用户零操作。延后跑：整树拷贝要几秒，
      // 不能挡 MCP 握手；失败也只记日志，旧守护继续工作。
      setTimeout(() => {
        try {
          upgradeDaemonIfOutdated(PKG_VERSION);
        } catch {
          // upgradeDaemonIfOutdated 内部已兜错，这里纯保险
        }
      }, 5000);
    } catch (error) {
      debugLog(`Failed to start server: ${error}`);
      throw error;
    }
  }

  /**
   * 看门狗：兜底退出机制
   *
   * 背景：经 npx / npm exec 启动时，进程链为 Cursor → npm exec → node。
   * Cursor 关闭后，stdin 的 EOF 在该中间层下不可靠，node 易变成孤儿进程残留；
   * 叠加 HTTP server 是常驻 active handle，进程无法自然退出。
   *
   * 防线（按环境自适应）：
   * 1) 父进程死亡（被 init/launchd 收养，ppid 变为 1）→ 立即退出。**所有环境通用**。
   * 2) 超过 IDLE_TIMEOUT 无活动 → 判定所有 Cursor 窗口已关闭 → 退出。
   *    **仅 Cursor 插件环境（everOwnerPolled）且无 pending 等待时才退**：插件每秒轮询 HTTP 刷新活动时间、
   *    停了就是关窗。无插件 host（Claude Desktop / CLI / 其他 MCP 客户端 / fe-ai-flow）没有轮询心跳、
   *    idle 是常态、不靠它退出、只走防线 1 + stdin EOF（见 main 的 stdin close/end/error）。
   * 3) 曾被本窗口插件轮询、但久未再收到（僵尸实例、只剩别的窗口扫端口续命）→ 退出。
   */
  private startWatchdog(): void {
    const IDLE_TIMEOUT = process.env.MCP_FEEDBACK_IDLE_TIMEOUT
      ? parseInt(process.env.MCP_FEEDBACK_IDLE_TIMEOUT, 10)
      : 30000;

    this.watchdogTimer = setInterval(() => {
      // 防线 1：父进程已死，自己成了孤儿进程
      if (process.ppid === 1) {
        debugLog('Parent process gone (ppid=1), exiting...');
        this.stop();
        process.exit(0);
      }

      // 防线 2：长时间无任何活动 = Cursor 已全部关闭。
      // 仅对「Cursor 插件环境」（everOwnerPolled：曾被自己窗口插件轮询过）生效——插件每秒轮询、
      // 停了就是关窗。无插件 host（Claude Desktop / CLI / 其他 MCP 客户端 / fe-ai-flow 等）没有轮询心跳、
      // idle 是常态、绝不能据此退出：否则 AI 调 interactive_feedback 等用户飞书回复的那几分钟里进程会自杀、
      // 回复永远回不来。这类 host 完全靠 stdin close/end/error（见 main）+ 防线 1（ppid===1）退出。
      // 另外：只要还有 pending 反馈在等用户、任何环境都不 idle 退出（正在等用户，绝不能死）。
      const idle = Date.now() - this.lastActivityTime;
      if (
        this.everOwnerPolled &&
        this.pendingRequests.size === 0 &&
        idle > IDLE_TIMEOUT
      ) {
        debugLog(`No activity for ${idle}ms (> ${IDLE_TIMEOUT}ms), assuming Cursor closed, exiting...`);
        this.stop();
        process.exit(0);
      }

      // 防线 3：本实例曾被自己窗口插件轮询，但久未再收到（只剩别的活跃窗口在扫端口刷 lastActivityTime）
      // → 我的窗口已关、本实例是僵尸 → 退出，避免持续被全局 pending 计数误算成「另一个在等的窗口」。
      // ⚠️ 与防线 2 同款约束：还有 pending 反馈在等用户时绝不退——曾因缺这一条，AI 在等待反馈期间
      //    传了与窗口工作区不同的 project_directory（改写 owner 后心跳失配），30 秒后实例被当僵尸杀掉，
      //    正在等待的 interactive_feedback 直接报 "MCP error -32000: Connection closed"。
      const ownerIdle = Date.now() - this.lastOwnerPollTime;
      if (
        this.everOwnerPolled &&
        this.pendingRequests.size === 0 &&
        ownerIdle > IDLE_TIMEOUT
      ) {
        debugLog(`Owner window idle for ${ownerIdle}ms, stale instance, exiting...`);
        this.stop();
        process.exit(0);
      }
    }, 5000);

    // 不让 watchdog 自身阻止进程的自然退出
    this.watchdogTimer.unref();
  }

  /**
   * 停止服务器（幂等：重复调用 / server.close() 触发 onclose 再次进入时直接返回）
   */
  stop(): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    debugLog('Stopping server...');

    // 停止防睡眠（子进程退出，电源断言自动释放）
    this.keepAwake.stop();

    // 关闭看门狗定时器
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    // 关闭 HTTP 服务器
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    // 清理待处理的请求
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
    }
    this.pendingRequests.clear();

    // 清理忙时队列的过期定时器（进程将退出，消息由 60 分钟兜底逻辑以外的重启场景自然失效）
    for (const q of this.queuedInbound) {
      clearTimeout(q.expiryTimer);
    }
    this.queuedInbound = [];
    
    // 关闭 MCP 服务器
    this.server.close();
    debugLog('Server stopped');
  }
}

// 主函数
async function main() {
  // 子命令：常驻守护的安装 / 卸载 / 状态查询（供 npx cursor-feedback install-daemon 等直接使用）
  const argv = process.argv.slice(2);
  const sub = argv.find((a) => !a.startsWith('-'));
  if (sub === 'install-daemon' || sub === 'uninstall-daemon' || sub === 'daemon-status') {
    try {
      const status =
        sub === 'install-daemon' ? installDaemon()
        : sub === 'uninstall-daemon' ? uninstallDaemon()
        : daemonStatus();
      // 子命令是给人看的，结果走 stdout（无 MCP 客户端，无 stdio 污染问题）
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      process.exit(0);
    } catch (e) {
      process.stderr.write(String(e) + '\n');
      process.exit(1);
    }
  }

  const daemonMode = argv.includes('--daemon');
  const port = 61927;
  const server = new McpFeedbackServer(port, daemonMode);
  
  // 处理进程信号
  process.on('SIGINT', () => {
    debugLog('Received SIGINT');
    server.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    debugLog('Received SIGTERM');
    server.stop();
    process.exit(0);
  });

  // stdin 退出钩子仅用于「被 MCP 客户端拉起」的场景。守护模式下 stdin 是 /dev/null，
  // 启动瞬间就会触发 close/end，装上这些钩子进程会立刻自杀。
  if (!daemonMode) {
    // 监听 stdin 关闭（Cursor 关闭时会触发）
    process.stdin.on('close', () => {
      debugLog('stdin closed, exiting...');
      server.stop();
      // 给 100ms 缓冲后强制退出
      setTimeout(() => process.exit(0), 100);
    });

    process.stdin.on('end', () => {
      debugLog('stdin ended, exiting...');
      server.stop();
      setTimeout(() => process.exit(0), 100);
    });

    // stdin 出错（父进程经 npx 中间层异常断开时可能触发）同样退出，避免残留
    process.stdin.on('error', (error) => {
      debugLog(`stdin error, exiting: ${error}`);
      server.stop();
      setTimeout(() => process.exit(0), 100);
    });
  }

  // 捕获未处理的异常：记录日志后退出。
  // ⚠️ 绝不能“吞掉异常继续运行”——否则 stdin 在父进程断开后产生的反复错误会形成
  //    busy-loop，导致 CPU 占满且进程永不退出（本次修复的核心症状之一）。
  process.on('uncaughtException', (error) => {
    debugLog(`Uncaught exception, exiting: ${error?.stack || error}`);
    try {
      server.stop();
    } catch {
      // ignore
    }
    process.exit(1);
  });

  // 捕获未处理的 Promise 拒绝（仅记录；Promise 拒绝本身不会造成 busy-loop）
  process.on('unhandledRejection', (reason) => {
    debugLog(`Unhandled rejection: ${reason}`);
  });

  await server.start();
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
