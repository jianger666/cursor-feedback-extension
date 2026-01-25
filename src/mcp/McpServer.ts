import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as os from 'os';

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
 * MCP Server - 独立运行的 MCP 服务
 * 
 * 架构说明：
 * 1. MCP Server 通过 stdio 与 AI Agent (Cursor) 通信
 * 2. 同时启动一个 HTTP Server 用于与 VS Code 插件通信
 * 3. 当 AI 调用 interactive_feedback 工具时，通知 VS Code 插件显示反馈界面
 * 4. VS Code 插件收集用户反馈后，通过 HTTP 接口返回结果
 */
export class McpServer {
  private server: Server;
  private httpServer: http.Server | null = null;
  private port: number;
  private isRunning: boolean = false;
  
  // 待处理的反馈请求
  private pendingRequests: Map<string, {
    resolve: (value: FeedbackResponse | null) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  // 当前反馈请求
  private currentRequest: FeedbackRequest | null = null;

  constructor(port: number = 61927) {
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
            description: `Interactive feedback collection tool for LLM agents.

USAGE RULES:
1. During any process, task, or conversation, whether asking, replying, or completing phased tasks, you must call this tool to ask for feedback.
2. Unless receiving termination instructions, all steps must repeatedly call this tool.
3. Whenever user feedback is received, if the feedback content is not empty, you must call this tool again and adjust behavior based on the feedback content.
4. Only when the user explicitly indicates "end" or "no more interaction needed" can you stop calling this tool, and the process is considered complete.
5. You should summarize what have done, and provide project directory through args to let user know what you have done to provide feedback for next step.
6. IMPORTANT: If feedback request times out, you MUST call this tool again to continue waiting for user feedback. Do not give up after timeout.

Args:
    project_directory: Project directory path for context (MUST be the absolute path of current workspace)
    summary: Summary of AI work completed for user review (supports Markdown)
    timeout: Timeout in seconds for waiting user feedback (default: 300 seconds = 5 minutes)

Returns:
    list: List containing TextContent and MCPImage objects representing user feedback`,
            inputSchema: {
              type: 'object',
              properties: {
                project_directory: {
                  type: 'string',
                  description: 'Project directory path for context (MUST be the absolute path of current workspace)',
                  default: '.',
                },
                summary: {
                  type: 'string',
                  description: 'Summary of AI work completed for user review (supports Markdown)',
                  default: 'I have completed the task you requested.',
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in seconds for waiting user feedback (default: 300 seconds = 5 minutes)',
                  default: 300,
                },
              },
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

      switch (name) {
        case 'interactive_feedback':
          return this.handleInteractiveFeedback(args);
        case 'get_system_info':
          return this.handleGetSystemInfo();
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  /**
   * 处理交互式反馈请求
   */
  private async handleInteractiveFeedback(args: Record<string, unknown> | undefined): Promise<{
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  }> {
    const projectDir = (args?.project_directory as string) || '.';
    const summary = (args?.summary as string) || 'I have completed the task you requested.';
    // 超时时间优先级：环境变量 > 工具参数 > 默认值（300秒）
    // 这样用户配置的环境变量永远生效，不会被 AI 覆盖
    const envTimeout = process.env.MCP_FEEDBACK_TIMEOUT ? parseInt(process.env.MCP_FEEDBACK_TIMEOUT, 10) : null;
    const timeout = envTimeout || (args?.timeout as number) || 300;

    const requestId = this.generateRequestId();
    
    // 创建反馈请求
    this.currentRequest = {
      id: requestId,
      summary,
      projectDir,
      timeout,
      timestamp: Date.now(),
    };

    console.error(`[MCP] Feedback request created: ${requestId}`);
    console.error(`[MCP] Waiting for VS Code extension to collect feedback...`);

    try {
      // 等待用户反馈
      const result = await this.waitForFeedback(requestId, timeout * 1000);

      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: 'User cancelled the feedback or timeout.',
            },
          ],
        };
      }

      const contentItems: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];

      // 构建反馈文本
      let feedbackText = '';
      
      // 添加文字反馈
      if (result.interactive_feedback) {
        feedbackText += `=== User Feedback ===\n${result.interactive_feedback}`;
      }

      // 添加附加文件路径
      if (result.attachedFiles && result.attachedFiles.length > 0) {
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
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
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
   * 启动 HTTP 服务器，用于与 VS Code 插件通信
   */
  private startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
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
        if (req.method === 'GET' && req.url === '/api/feedback/current') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.currentRequest || null));
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
              
              const pending = this.pendingRequests.get(requestId);
              if (pending) {
                clearTimeout(pending.timeout);
                pending.resolve(feedback);
                this.pendingRequests.delete(requestId);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
              } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request not found' }));
              }
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid request body' }));
            }
          });
          return;
        }

        // 健康检查
        if (req.method === 'GET' && req.url === '/api/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', version: '0.0.1' }));
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      });

      this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[MCP] Port ${this.port} is already in use`);
          reject(err);
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(this.port, '127.0.0.1', () => {
        console.error(`[MCP] HTTP Server listening on http://127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.error('[MCP] Server is already running');
      return;
    }

    try {
      // 启动 HTTP 服务器
      await this.startHttpServer();
      
      // 启动 MCP stdio 传输
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      
      this.isRunning = true;
      console.error('[MCP] MCP Server started successfully');
    } catch (error) {
      console.error('[MCP] Failed to start server:', error);
      throw error;
    }
  }

  /**
   * 停止服务器
   */
  stop(): void {
    if (!this.isRunning) {
      return;
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
    this.isRunning = false;
    console.error('[MCP] Server stopped');
  }
}

/**
 * 独立运行入口
 */
async function main() {
  const port = parseInt(process.env.MCP_PORT || '8766', 10);
  const server = new McpServer(port);
  
  process.on('SIGINT', () => {
    server.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    server.stop();
    process.exit(0);
  });

  await server.start();
}

// 如果直接运行此文件
if (require.main === module) {
  main().catch(console.error);
}
