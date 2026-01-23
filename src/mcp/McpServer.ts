import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * MCP 服务器 - 处理 AI Agent 的工具调用
 */
export class McpServer {
  private server: Server;
  private feedbackProvider: any;
  private port: number;
  private isRunning: boolean = false;

  constructor(port: number, feedbackProvider: any) {
    this.port = port;
    this.feedbackProvider = feedbackProvider;
    
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
5. You should summarize what have done, and provide project directory through args to let user know what you have done to provide feedback for next step.`,
            inputSchema: {
              type: 'object',
              properties: {
                project_directory: {
                  type: 'string',
                  description: 'Project directory path for context',
                  default: '.',
                },
                summary: {
                  type: 'string',
                  description: 'Summary of AI work completed for user review',
                  default: 'I have completed the task you requested.',
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in seconds for waiting user feedback (default: 600 seconds)',
                  default: 600,
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
  private async handleInteractiveFeedback(args: any): Promise<any> {
    const projectDir = args?.project_directory || '.';
    const summary = args?.summary || 'I have completed the task you requested.';
    const timeout = args?.timeout || 600;

    try {
      // 调用 VS Code 插件的反馈界面
      const result = await this.feedbackProvider.requestFeedback(summary, projectDir);

      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: 'User cancelled the feedback.',
            },
          ],
        };
      }

      const contentItems: any[] = [];

      // 添加文字反馈
      if (result.interactive_feedback) {
        contentItems.push({
          type: 'text',
          text: `=== User Feedback ===\n${result.interactive_feedback}`,
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
    }
  }

  /**
   * 处理获取系统信息请求
   */
  private handleGetSystemInfo(): any {
    const systemInfo = {
      platform: process.platform,
      nodeVersion: process.version,
      arch: process.arch,
      interfaceType: 'VS Code Extension',
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
   * 启动服务器
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('MCP Server is already running');
      return;
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.isRunning = true;
    console.log(`MCP Server started`);
  }

  /**
   * 停止服务器
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }
    
    this.server.close();
    this.isRunning = false;
    console.log('MCP Server stopped');
  }
}
