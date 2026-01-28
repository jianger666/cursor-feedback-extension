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
  
  // 待处理的反馈请求
  private pendingRequests: Map<string, {
    resolve: (value: FeedbackResponse | null) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  // 当前反馈请求
  private currentRequest: FeedbackRequest | null = null;

  // 所属工作区（只在 AI 调用 feedback 时设置）
  // 只有来自同一工作区的轮询才会更新活动时间
  private ownerWorkspace: string | null = null;

  // Server 启动时间
  private readonly startTime: number = Date.now();

  constructor(port: number = 8766) {
    this.port = port;
    
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
    project_directory: 【必填】项目目录的绝对路径，用于正确匹配项目窗口
    summary: AI 工作摘要，供用户查看（支持 Markdown）
    timeout: 等待用户反馈的超时时间（秒），默认 300 秒（5 分钟）

返回：
    用户反馈内容（文字/图片/文件路径），或 timeout/cancelled 状态`,
            inputSchema: {
              type: 'object',
              properties: {
                project_directory: {
                  type: 'string',
                  description: 'Project directory absolute path (REQUIRED - must be the absolute path of current workspace for correct project matching)',
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

    const projectDir = args.project_directory as string;
    // summary 支持别名 message
    const summary = (args?.summary as string) || (args?.message as string) || '我已完成您的请求。';
    // 超时时间优先级：环境变量 > 工具参数 > 默认值（300秒）
    // 这样用户配置的环境变量永远生效，不会被 AI 覆盖
    const envTimeout = process.env.MCP_FEEDBACK_TIMEOUT ? parseInt(process.env.MCP_FEEDBACK_TIMEOUT, 10) : null;
    const timeout = envTimeout || (args?.timeout as number) || 300;

    const requestId = this.generateRequestId();
    
    // AI 调用 feedback 时设置 ownerWorkspace（这是唯一正确的时机）
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    this.ownerWorkspace = normalize(projectDir);
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

    try {
      // 等待用户反馈
      const result = await this.waitForFeedback(requestId, timeout * 1000);

      if (!result) {
        debugLog('Feedback request timed out or cancelled');
        // MCP_AUTO_RETRY 环境变量控制是否显示重试指示，默认 true
        const autoRetry = process.env.MCP_AUTO_RETRY !== 'false';
        const timeoutMessage = autoRetry
          ? 'User cancelled the feedback or timeout. 【必须立即重新调用此工具继续等待用户反馈】'
          : 'User cancelled the feedback or timeout.';
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
      this.currentRequest = null;
    }
  }

  /**
   * 等待用户反馈
   */
  private waitForFeedback(requestId: string, timeoutMs: number): Promise<FeedbackResponse | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        debugLog(`Request ${requestId} timed out`);
        this.pendingRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(requestId, { 
        resolve, 
        reject: () => resolve(null), 
        timeout 
      });
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
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
          // 注意：活动时间的更新已移到具体的请求处理中
          // 只有来自匹配工作区的请求才会更新活动时间

          // 设置 CORS 头
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

          if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
          }

          // 获取当前反馈请求
          if (req.method === 'GET' && req.url?.startsWith('/api/feedback/current')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          // 返回当前请求、ownerWorkspace 和 startTime
          res.end(JSON.stringify({
            request: this.currentRequest || null,
            ownerWorkspace: this.ownerWorkspace,
            startTime: this.startTime,
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
          // 端口被占用，使用下一个端口（不关闭旧的 MCP Server，支持多项目独立运行）
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
   * 启动服务器
   */
  async start(): Promise<void> {
    try {
      debugLog('Starting MCP Feedback Server...');
      
      // 启动 HTTP 服务器
      await this.startHttpServer();
      
      // 启动 MCP stdio 传输
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      debugLog('MCP Server started successfully');
      debugLog('Waiting for tool calls from AI agent...');
    } catch (error) {
      debugLog(`Failed to start server: ${error}`);
      throw error;
    }
  }

  /**
   * 停止服务器
   */
  stop(): void {
    debugLog('Stopping server...');

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

  // 捕获未处理的异常，记录日志但不退出进程
  process.on('uncaughtException', (error) => {
    debugLog(`Uncaught exception (continuing): ${error}`);
    // 不退出进程，让 MCP 连接保持
  });

  // 捕获未处理的 Promise 拒绝
  process.on('unhandledRejection', (reason, promise) => {
    debugLog(`Unhandled rejection (continuing): ${reason}`);
    // 不退出进程，让 MCP 连接保持
  });

  await server.start();
}

main().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
