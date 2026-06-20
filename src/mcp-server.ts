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
}

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
  }> = new Map();

  // 当前反馈请求
  private currentRequest: FeedbackRequest | null = null;

  // 飞书桥接（可选；未配置时不加载 SDK、零开销）
  private feishu = new FeishuBridge();
  private feishuRoutingSetup = false;
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
      }
    | null = null;
  /** 抢跑暂存有效期：超过则视为与当前任务无关，丢弃 */
  private static readonly STASH_TTL_MS = 8000;
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

  // Cursor 在 spawn 本 MCP server 时注入的「真实所属工作区」，精确指向发起对话的那个窗口。
  // 这是可靠的归属信号：AI 传的 project_directory 可能被填成对话里聊到的另一个项目，
  // 用它路由会把反馈发到错误窗口、当前窗口收不到（用户反馈的 bug）。拿不到时回退到 AI 传参。
  private readonly realWorkspace: string | null =
    (process.env.WORKSPACE_FOLDER_PATHS || '').split(',')[0].trim() || null;

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

  constructor(port: number = 8766) {
    this.port = port;
    this.basePort = port;
    
    this.server = new Server(
      {
        name: 'cursor-feedback-server',
        version: '0.0.1',
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
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // AI 发起调用，刷新活动时间，避免被 watchdog 误判为闲置
      this.lastActivityTime = Date.now();
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'interactive_feedback':
            return await this.handleInteractiveFeedback(args);
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
   */
  private async handleInteractiveFeedback(args: Record<string, unknown> | undefined): Promise<{
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

    // 归属以 Cursor 注入的真实工作区为准（修复：AI 把 project_directory 传成对话里聊到的
    // 另一个项目时，反馈会发到错误窗口、当前窗口收不到）。拿不到 env 时才回退到 AI 传参。
    const projectDir = this.realWorkspace || (args.project_directory as string);
    // summary 支持别名 message
    const summary = (args?.summary as string) || (args?.message as string) || '我已完成您的请求。';
    // 超时时间优先级：环境变量 > 工具参数 > 默认值（300秒）
    // 这样用户配置的环境变量永远生效，不会被 AI 覆盖
    const envTimeout = process.env.MCP_FEEDBACK_TIMEOUT ? parseInt(process.env.MCP_FEEDBACK_TIMEOUT, 10) : null;
    const timeout = envTimeout || (args?.timeout as number) || 300;

    const requestId = this.generateRequestId();

    // 作废上一轮残留的「僵尸」请求：单实例单窗口同时只应有一个活跃反馈请求。
    // 旧请求多半是对话被压缩 / 客户端取消后还卡在 await 的残留（要等 timeout 才自然结束），
    // 不清理会让 pendingCount 虚高、全局视角误判「多个窗口在等」
    //（即你看到的两个一模一样的 cursor-feedback-extension）。
    this.cancelStalePending();

    // AI 调用 feedback 时设置 ownerWorkspace（这是唯一正确的时机）
    this.ownerWorkspace = this.normalizePath(projectDir);
    debugLog(`Owner workspace set to: ${this.ownerWorkspace}`);
    
    // 创建反馈请求
    this.currentRequest = {
      id: requestId,
      summary,
      projectDir,
      timeout,
      timestamp: Date.now(),
    };

    debugLog(`Feedback request created: ${requestId}`);
    debugLog(`Summary: ${summary}`);
    debugLog(`Project: ${projectDir}`);
    debugLog(`Timeout: ${timeout}s`);
    debugLog(`Waiting for VS Code extension to collect feedback...`);

    // 飞书：已配置则推送一张反馈请求卡片（失败不影响插件主流程）
    if (this.feishu.isConfigured()) {
      this.feishu.sendFeedbackCard(requestId, summary, projectDir).catch(() => {});
    }

    try {
      // 等待用户反馈
      const result = await this.waitForFeedback(requestId, timeout * 1000);

      if (!result) {
        debugLog('Feedback wait window elapsed without user input');
        // 超时续期开关：MCP_AUTO_RETRY=false 时关闭（超时即结束），默认开启（超时返回续期提醒）。
        // 关键：这里【绝不能】说成 "cancelled"——那会让 AI 误以为用户主动取消而结束对话，
        // 这正是“超时后 AI 直接收尾、不再续命”的根因。改为明确区分“超时 ≠ 取消”。
        // 优先用 UI 开关（autoRetryOverride），未设置时回退到环境变量 / 默认开启
        const autoRetry = this.autoRetryOverride !== null
          ? this.autoRetryOverride
          : (process.env.MCP_AUTO_RETRY !== 'false');
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

      if (parentId) {
        // 用户「回复」了某条卡片 → 用 parent_id 精确路由
        const reqId = this.feishu.resolveParent(parentId);
        if (reqId) {
          // 这张卡片是本实例发出的
          if (this.pendingRequests.has(reqId)) {
            this.submitFromFeishu(reqId, text, chatId, images, files, messageId);
          } else {
            // 卡片是本实例发的，但请求已结束（超时 / 已回复）→ 明确告知，不必广播
            this.feishu.replyText(chatId, '这条反馈已经结束了（可能已超时或已被回复）。');
          }
        } else {
          // 不是本实例发出的卡片 → 广播给其他窗口的 server
          this.broadcastFeishuInbound(parentId, text, chatId, images, files, messageId);
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
        // 抢跑兜底：此刻全局无人等待，但很可能 AI 正要发起下一轮（卡片还没注册）。
        // 暂存到收到消息的本实例，等下一轮 pending 注册时立即兑现。
        this.stashedInbound = { text, chatId, images, files, at: Date.now(), messageId };
        // 轻回执：先给消息加 ✅ 表情（无未读）；兑现到具体任务时不再重复回执
        this.feishu.reactDone(messageId || undefined, chatId);
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
        // 多个窗口在等 → 不猜。项目名可能重复（同一项目开多窗口），逐项列出也无法区分，
        // 故不逐项列，直接引导用户去点想回复的那张卡片——回复哪张就精确回到哪个窗口。
        this.feishu.replyText(
          chatId,
          `当前有 ${globalCount} 个窗口在等反馈，没法自动判断你要回复哪个。\n请直接在你想回复的那张卡片上点「回复」再发，回复哪张就回到哪个窗口。`,
        );
      }
    });
  }

  private projectName(dir: string): string {
    return dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || dir;
  }

  /** 归一化路径用于跨进程/跨平台比对（统一斜杠、去尾斜杠、小写） */
  private normalizePath(p: string): string {
    return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
      project_directory: this.currentRequest?.projectDir || '',
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

  /** 把飞书回复广播给其他窗口的 server（跨实例路由兜底） */
  private broadcastFeishuInbound(
    parentId: string,
    text: string,
    chatId: string,
    images: FeedbackResponse['images'] = [],
    attachedFiles: string[] = [],
    messageId?: string,
  ) {
    const body = JSON.stringify({ parentId, text, chatId, images, attachedFiles, messageId });
    for (let p = this.basePort; p < this.basePort + McpFeedbackServer.PORT_SCAN_RANGE; p++) {
      if (p === this.port) continue;
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
          res.on('data', () => {});
          res.on('end', () => {});
        }
      );
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.write(body);
      req.end();
    }
  }

  /**
   * 向其他窗口的 server 查询各自的 pending 列表（仅项目名，用于全局视角判断 + 提示文案）。
   * 用于无 parent_id 的「无主消息」：飞书只推给一个窗口，需汇总全局才能正确决策。
   */
  private queryRemotePending(): Promise<Array<{ port: number; list: Array<{ projectName: string }> }>> {
    const ports: number[] = [];
    for (let p = this.basePort; p < this.basePort + McpFeedbackServer.PORT_SCAN_RANGE; p++) {
      if (p !== this.port) ports.push(p);
    }
    return Promise.all(ports.map((port) => this.fetchRemotePending(port)));
  }

  private fetchRemotePending(port: number): Promise<{ port: number; list: Array<{ projectName: string }> }> {
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/api/feishu/pending', method: 'GET', timeout: 1500 },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const j = JSON.parse(body) as { list?: Array<{ projectName: string }> };
              resolve({ port, list: Array.isArray(j.list) ? j.list : [] });
            } catch {
              resolve({ port, list: [] });
            }
          });
        },
      );
      req.on('error', () => resolve({ port, list: [] }));
      req.on('timeout', () => { req.destroy(); resolve({ port, list: [] }); });
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
   * 作废本实例所有未决的反馈请求（在每次新请求进来时调用）。
   * 单个 server 实例服务单个 Cursor 窗口的单个对话，同时只应有一个活跃反馈请求；
   * resolve(null) 让旧的 await 自然返回走超时分支，其 finally 因 id 不匹配不会误清新请求。
   */
  private cancelStalePending() {
    if (this.pendingRequests.size === 0) return;
    for (const [reqId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.resolve(null);
      this.feishu.clearPending(reqId);
    }
    this.pendingRequests.clear();
  }

  /**
   * 等待用户反馈
   */
  private waitForFeedback(requestId: string, timeoutMs: number): Promise<FeedbackResponse | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        debugLog(`Request ${requestId} timed out`);
        this.pendingRequests.delete(requestId);
        // 飞书侧的清理统一交给 handleInteractiveFeedback 的 finally（clearPending），这里不再重复。
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(requestId, { 
        resolve, 
        reject: () => resolve(null), 
        timeout 
      });

      // 抢跑兑现：用户在空窗期「无主」发来的消息已被暂存，本轮 pending 一注册立即作为回复提交
      this.tryConsumeStash(requestId);
    });
  }

  /**
   * 抢跑暂存兑现：若存在近期「无主」飞书消息，立即作为指定请求的回复提交。
   * 超过 STASH_TTL_MS 的暂存视为与当前任务无关，直接丢弃。
   */
  private tryConsumeStash(requestId: string): void {
    const stash = this.stashedInbound;
    if (!stash) return;
    this.stashedInbound = null;
    if (Date.now() - stash.at > McpFeedbackServer.STASH_TTL_MS) {
      debugLog('Stashed inbound expired, dropped');
      return;
    }
    debugLog(`Consuming stashed inbound for request: ${requestId}`);
    this.submitFromFeishu(requestId, stash.text, stash.chatId, stash.images, stash.files);
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
          try {
            const u = new URL(req.url, 'http://127.0.0.1');
            // 「我的窗口」心跳：仅当轮询带的 workspace 匹配本实例归属时刷新。
            // 别的活跃窗口对全端口的扫描虽刷 lastActivityTime，但 workspace 不匹配、不刷此字段，
            // 故已关窗口的残留 server 不会被别人续命，可被 watchdog / 僵尸自检识别。
            const ws = this.normalizePath(u.searchParams.get('workspace') || '');
            if (ws && (ws === this.ownerWorkspace || ws === this.normalizePath(this.realWorkspace || ''))) {
              this.lastOwnerPollTime = Date.now();
              this.everOwnerPolled = true;
            }
          } catch {
            // 忽略解析错误
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // 返回当前请求、ownerWorkspace、startTime，以及当前生效的 autoRetry（供 UI 初始同步）
          res.end(JSON.stringify({
            request: this.currentRequest || null,
            ownerWorkspace: this.ownerWorkspace,
            startTime: this.startTime,
            autoRetry: this.autoRetryOverride !== null ? this.autoRetryOverride : (process.env.MCP_AUTO_RETRY !== 'false'),
            feishu: this.feishu.getStatus(),
            feishuResolvedId: (this.lastFeishuResolved && Date.now() - this.lastFeishuResolved.at < 30000) ? this.lastFeishuResolved.id : null,
          }));
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
              if (pending) {
                clearTimeout(pending.timeout);
                pending.resolve(feedback);
                this.pendingRequests.delete(requestId);
                // 飞书侧清理同样交给 finally（clearPending）统一处理，这里不再重复。
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
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
          res.end(JSON.stringify({ count: list.length, list }));
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

        // 健康检查
        if (req.method === 'GET' && req.url === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            status: 'ok', 
            version: '0.0.1',
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
   * 两道防线：
   * 1) 父进程死亡（被 init/launchd 收养，ppid 变为 1）→ 立即退出；
   * 2) 超过 IDLE_TIMEOUT 没有任何插件轮询 / MCP 调用 → 判定所有 Cursor 窗口已关闭 → 退出。
   *    （插件每秒轮询 HTTP，只要还有任意 Cursor 窗口存活就会持续刷新活动时间）
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

      // 防线 2：长时间无任何活动 = Cursor 已全部关闭
      const idle = Date.now() - this.lastActivityTime;
      if (idle > IDLE_TIMEOUT) {
        debugLog(`No activity for ${idle}ms (> ${IDLE_TIMEOUT}ms), assuming Cursor closed, exiting...`);
        this.stop();
        process.exit(0);
      }

      // 防线 3：本实例曾被自己窗口插件轮询，但久未再收到（只剩别的活跃窗口在扫端口刷 lastActivityTime）
      // → 我的窗口已关、本实例是僵尸 → 退出，避免持续被全局 pending 计数误算成「另一个在等的窗口」。
      const ownerIdle = Date.now() - this.lastOwnerPollTime;
      if (this.everOwnerPolled && ownerIdle > IDLE_TIMEOUT) {
        debugLog(`Owner window idle for ${ownerIdle}ms, stale instance, exiting...`);
        this.stop();
        process.exit(0);
      }
    }, 5000);

    // 不让 watchdog 自身阻止进程的自然退出
    this.watchdogTimer.unref();
  }

  /**
   * 停止服务器
   */
  stop(): void {
    debugLog('Stopping server...');

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
    
    // 关闭 MCP 服务器
    this.server.close();
    debugLog('Server stopped');
  }
}

// 主函数
async function main() {
  const port = 61927;
  const server = new McpFeedbackServer(port);
  
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
