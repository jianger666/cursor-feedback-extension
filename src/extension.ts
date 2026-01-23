import * as vscode from 'vscode';
import { FeedbackPanel } from './webview/FeedbackPanel';
import { McpServer } from './mcp/McpServer';

let mcpServer: McpServer | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Feedback extension is now active!');

  // 注册侧边栏 WebView
  const feedbackViewProvider = new FeedbackViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'cursorFeedback.feedbackView',
      feedbackViewProvider
    )
  );

  // 注册命令：显示反馈面板
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.showPanel', () => {
      FeedbackPanel.createOrShow(context.extensionUri);
    })
  );

  // 注册命令：启动 MCP 服务器
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.startServer', async () => {
      if (mcpServer) {
        vscode.window.showInformationMessage('MCP Server is already running');
        return;
      }
      
      const config = vscode.workspace.getConfiguration('cursorFeedback');
      const port = config.get<number>('serverPort', 8766);
      
      mcpServer = new McpServer(port, feedbackViewProvider);
      await mcpServer.start();
      vscode.window.showInformationMessage(`MCP Server started on port ${port}`);
    })
  );

  // 注册命令：停止 MCP 服务器
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.stopServer', () => {
      if (mcpServer) {
        mcpServer.stop();
        mcpServer = null;
        vscode.window.showInformationMessage('MCP Server stopped');
      }
    })
  );

  // 自动启动服务器
  const config = vscode.workspace.getConfiguration('cursorFeedback');
  if (config.get<boolean>('autoStartServer', true)) {
    vscode.commands.executeCommand('cursorFeedback.startServer');
  }
}

export function deactivate() {
  if (mcpServer) {
    mcpServer.stop();
    mcpServer = null;
  }
}

/**
 * 侧边栏 WebView Provider
 */
class FeedbackViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cursorFeedback.feedbackView';
  private _view?: vscode.WebviewView;
  private _pendingFeedbackRequest?: {
    summary: string;
    projectDir: string;
    resolve: (value: any) => void;
  };

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // 处理来自 WebView 的消息
    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'submitFeedback':
          this._handleFeedbackSubmit(data.payload);
          break;
        case 'ready':
          console.log('Feedback WebView is ready');
          break;
      }
    });
  }

  /**
   * 请求用户反馈
   */
  public async requestFeedback(summary: string, projectDir: string): Promise<any> {
    return new Promise((resolve) => {
      this._pendingFeedbackRequest = { summary, projectDir, resolve };
      
      // 通知 WebView 显示反馈请求
      if (this._view) {
        this._view.show?.(true);
        this._view.webview.postMessage({
          type: 'showFeedbackRequest',
          payload: { summary, projectDir }
        });
      }
    });
  }

  /**
   * 处理反馈提交
   */
  private _handleFeedbackSubmit(payload: any) {
    if (this._pendingFeedbackRequest) {
      this._pendingFeedbackRequest.resolve(payload);
      this._pendingFeedbackRequest = undefined;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const config = vscode.workspace.getConfiguration('cursorFeedback');
    const language = config.get<string>('language', 'zh-CN');

    return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor Feedback</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      padding: 12px;
    }
    
    .container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      height: 100%;
    }
    
    .section {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 12px;
    }
    
    .section-title {
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }
    
    .summary-content {
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 200px;
      overflow-y: auto;
      font-size: 12px;
      line-height: 1.5;
    }
    
    .feedback-input {
      width: 100%;
      min-height: 120px;
      resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 8px;
      font-family: inherit;
      font-size: inherit;
    }
    
    .feedback-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    .quick-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    
    .quick-btn {
      padding: 4px 10px;
      font-size: 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    
    .quick-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .submit-btn {
      width: 100%;
      padding: 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
    }
    
    .submit-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    
    .submit-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .status {
      text-align: center;
      padding: 20px;
      color: var(--vscode-descriptionForeground);
    }
    
    .status.waiting {
      color: var(--vscode-notificationsInfoIcon-foreground);
    }
    
    .image-upload {
      margin-top: 8px;
    }
    
    .image-upload-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    
    .image-preview {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    
    .image-preview img {
      max-width: 80px;
      max-height: 80px;
      border-radius: 4px;
      object-fit: cover;
    }
    
    .hidden {
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- 等待状态 -->
    <div id="waitingStatus" class="status waiting">
      <p>等待 AI 请求反馈...</p>
      <p style="font-size: 11px; margin-top: 8px;">当 AI 需要您的反馈时，这里会显示输入界面</p>
    </div>
    
    <!-- 反馈表单 -->
    <div id="feedbackForm" class="hidden">
      <!-- AI 摘要 -->
      <div class="section">
        <div class="section-title">📋 AI 工作摘要</div>
        <div id="summaryContent" class="summary-content"></div>
      </div>
      
      <!-- 反馈输入 -->
      <div class="section">
        <div class="section-title">💬 您的反馈</div>
        <textarea 
          id="feedbackInput" 
          class="feedback-input" 
          placeholder="请输入您的反馈..."
        ></textarea>
        
        <!-- 快捷按钮 -->
        <div class="quick-buttons">
          <button class="quick-btn" data-text="继续">继续</button>
          <button class="quick-btn" data-text="确认，没问题">确认</button>
          <button class="quick-btn" data-text="请修改">请修改</button>
          <button class="quick-btn" data-text="取消">取消</button>
        </div>
        
        <!-- 图片上传 -->
        <div class="image-upload">
          <button id="uploadBtn" class="image-upload-btn">
            📎 上传图片
          </button>
          <input type="file" id="imageInput" accept="image/*" multiple style="display:none">
          <div id="imagePreview" class="image-preview"></div>
        </div>
      </div>
      
      <!-- 提交按钮 -->
      <button id="submitBtn" class="submit-btn">提交反馈 (Ctrl+Enter)</button>
    </div>
  </div>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    // DOM 元素
    const waitingStatus = document.getElementById('waitingStatus');
    const feedbackForm = document.getElementById('feedbackForm');
    const summaryContent = document.getElementById('summaryContent');
    const feedbackInput = document.getElementById('feedbackInput');
    const submitBtn = document.getElementById('submitBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    const imageInput = document.getElementById('imageInput');
    const imagePreview = document.getElementById('imagePreview');
    
    let uploadedImages = [];
    let currentProjectDir = '';
    
    // 快捷按钮
    document.querySelectorAll('.quick-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        feedbackInput.value = btn.dataset.text;
        feedbackInput.focus();
      });
    });
    
    // 图片上传
    uploadBtn.addEventListener('click', () => imageInput.click());
    
    imageInput.addEventListener('change', (e) => {
      const files = e.target.files;
      for (const file of files) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const base64 = e.target.result;
          uploadedImages.push({
            name: file.name,
            data: base64.split(',')[1],
            size: file.size
          });
          
          // 显示预览
          const img = document.createElement('img');
          img.src = base64;
          imagePreview.appendChild(img);
        };
        reader.readAsDataURL(file);
      }
    });
    
    // 提交反馈
    function submitFeedback() {
      const feedback = feedbackInput.value.trim();
      
      vscode.postMessage({
        type: 'submitFeedback',
        payload: {
          interactive_feedback: feedback,
          images: uploadedImages,
          project_directory: currentProjectDir
        }
      });
      
      // 重置表单
      feedbackInput.value = '';
      uploadedImages = [];
      imagePreview.innerHTML = '';
      
      // 切换回等待状态
      feedbackForm.classList.add('hidden');
      waitingStatus.classList.remove('hidden');
    }
    
    submitBtn.addEventListener('click', submitFeedback);
    
    // 快捷键 Ctrl+Enter 提交
    feedbackInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        submitFeedback();
      }
    });
    
    // 接收来自插件的消息
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'showFeedbackRequest':
          waitingStatus.classList.add('hidden');
          feedbackForm.classList.remove('hidden');
          summaryContent.textContent = message.payload.summary;
          currentProjectDir = message.payload.projectDir;
          feedbackInput.focus();
          break;
      }
    });
    
    // 通知插件 WebView 已准备就绪
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
