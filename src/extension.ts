import * as vscode from 'vscode';
import * as http from 'http';

let feedbackViewProvider: FeedbackViewProvider | null = null;
let pollingInterval: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext) {
  console.log('Cursor Feedback extension is now active!');

  // 注册侧边栏 WebView（端口从 61927 开始自动扫描）
  feedbackViewProvider = new FeedbackViewProvider(context.extensionUri, 61927);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'cursorFeedback.feedbackView',
      feedbackViewProvider
    )
  );

  // 注册命令：显示反馈面板
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.showPanel', () => {
      vscode.commands.executeCommand('cursorFeedback.feedbackView.focus');
    })
  );

  // 注册命令：启动轮询
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.startPolling', () => {
      if (feedbackViewProvider) {
        feedbackViewProvider.startPolling();
        vscode.window.showInformationMessage('开始监听 MCP 反馈请求');
      }
    })
  );

  // 注册命令：停止轮询
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.stopPolling', () => {
      if (feedbackViewProvider) {
        feedbackViewProvider.stopPolling();
        vscode.window.showInformationMessage('已停止监听');
      }
    })
  );

  // 自动开始轮询
  setTimeout(() => {
    feedbackViewProvider?.startPolling();
  }, 1000);
}

export function deactivate() {
  if (feedbackViewProvider) {
    feedbackViewProvider.stopPolling();
  }
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
 * 获取当前工作区路径列表
 */
function getWorkspacePaths(): string[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) {
    return [];
  }
  return folders.map(f => f.uri.fsPath);
}

/**
 * 检查路径是否匹配当前工作区（精确匹配）
 * - 有工作区的窗口：只接收匹配工作区路径的消息
 * - 没有工作区的窗口：只接收没有指定项目路径的消息
 */
function isPathInWorkspace(targetPath: string): boolean {
  const workspacePaths = getWorkspacePaths();
  
  // 规范化路径（去除末尾斜杠，统一分隔符，小写）
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const normalizedTarget = normalize(targetPath);
  
  // 检查 targetPath 是否为空或默认值
  const isEmptyPath = !targetPath || targetPath === '.' || normalizedTarget === '' || normalizedTarget === '.';
  
  if (workspacePaths.length === 0) {
    // 没有打开工作区时，只接收没有指定项目路径的消息
    return isEmptyPath;
  }
  
  // 有工作区时，不接收空路径的消息
  if (isEmptyPath) {
    return false;
  }
  
  for (const wsPath of workspacePaths) {
    const normalizedWs = normalize(wsPath);
    // 精确匹配：只匹配完全相同的路径
    if (normalizedTarget === normalizedWs) {
      return true;
    }
  }
  
  return false;
}

/**
 * 侧边栏 WebView Provider
 */
class FeedbackViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cursorFeedback.feedbackView';
  private _view?: vscode.WebviewView;
  private _pollingInterval: NodeJS.Timeout | null = null;
  private _currentRequest: FeedbackRequest | null = null;
  private _basePort: number;
  private _activePort: number | null = null;
  private _portScanRange = 10; // 扫描端口范围

  constructor(
    private readonly _extensionUri: vscode.Uri,
    port: number
  ) {
    this._basePort = port;
  }

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
    webviewView.webview.onDidReceiveMessage(async data => {
      switch (data.type) {
        case 'submitFeedback':
          await this._handleFeedbackSubmit(data.payload);
          break;
        case 'ready':
          console.log('Feedback WebView is ready');
          // WebView 准备就绪后，检查是否有待处理的请求
          if (this._currentRequest) {
            this._showFeedbackRequest(this._currentRequest);
          }
          break;
        case 'checkServer':
          await this._checkServerHealth();
          break;
        case 'selectFile':
          await this._handleSelectFile();
          break;
        case 'selectFolder':
          await this._handleSelectFolder();
          break;
      }
    });

    // 当 view 变为可见时，检查当前请求
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this._currentRequest) {
        this._showFeedbackRequest(this._currentRequest);
      }
    });
  }

  /**
   * 开始轮询 MCP Server
   */
  public startPolling() {
    if (this._pollingInterval) {
      return;
    }

    console.log(`Starting polling MCP server from port ${this._basePort}`);
    
    this._pollingInterval = setInterval(async () => {
      await this._pollForFeedbackRequest();
    }, 1000); // 每秒检查一次

    // 立即执行一次
    this._pollForFeedbackRequest();
  }

  /**
   * 停止轮询
   */
  public stopPolling() {
    if (this._pollingInterval) {
      clearInterval(this._pollingInterval);
      this._pollingInterval = null;
    }
  }

  /**
   * 轮询检查是否有新的反馈请求
   * 会扫描多个端口以找到有活跃请求的 MCP Server
   */
  private async _pollForFeedbackRequest() {
    try {
      // 如果已知活跃端口，先检查该端口
      if (this._activePort) {
        const result = await this._checkPortForRequest(this._activePort);
        if (result.request) {
          this._handleNewRequest(result.request, result.port);
          return;
        } else if (result.connected && !result.request && this._currentRequest) {
          // 请求已被处理或超时
          this._currentRequest = null;
          this._showWaitingState();
          return;
        }
      }

      // 扫描端口范围寻找有请求的服务器
      for (let i = 0; i < this._portScanRange; i++) {
        const port = this._basePort + i;
        if (port === this._activePort) continue; // 已经检查过了
        
        const result = await this._checkPortForRequest(port);
        if (result.request) {
          this._activePort = port;
          this._handleNewRequest(result.request, port);
          return;
        }
      }

      // 没有找到任何请求
      if (this._currentRequest) {
        this._currentRequest = null;
        this._showWaitingState();
      }
    } catch (error) {
      // 服务器可能未启动，静默处理
    }
  }

  /**
   * 检查指定端口是否有反馈请求
   * 只返回属于当前工作区的请求
   */
  private async _checkPortForRequest(port: number): Promise<{
    connected: boolean;
    request: FeedbackRequest | null;
    port: number;
  }> {
    try {
      const response = await this._httpGet(`http://127.0.0.1:${port}/api/feedback/current`);
      const request = JSON.parse(response) as FeedbackRequest | null;
      
      // 如果有请求，检查是否属于当前工作区
      if (request && !isPathInWorkspace(request.projectDir)) {
        // 请求不属于当前工作区，忽略
        return { connected: true, request: null, port };
      }
      
      return { connected: true, request, port };
    } catch {
      return { connected: false, request: null, port };
    }
  }

  /**
   * 处理新的反馈请求
   */
  private _handleNewRequest(request: FeedbackRequest, port: number) {
    if (!this._currentRequest || request.id !== this._currentRequest.id) {
      console.log(`New feedback request received on port ${port}:`, request.id);
      this._currentRequest = request;
      this._activePort = port;
      
      // 自动聚焦到反馈面板
      vscode.commands.executeCommand('cursorFeedback.feedbackView.focus');
      
      this._showFeedbackRequest(request);
      
      // 显示通知（作为备用提示）
      vscode.window.showInformationMessage('AI 正在等待您的反馈');
    }
  }

  /**
   * 检查服务器健康状态
   */
  private async _checkServerHealth() {
    // 扫描端口查找可用的服务器
    for (let i = 0; i < this._portScanRange; i++) {
      const port = this._basePort + i;
      try {
        const response = await this._httpGet(`http://127.0.0.1:${port}/api/health`);
        const health = JSON.parse(response);
        this._view?.webview.postMessage({
          type: 'serverStatus',
          payload: { connected: true, port, ...health }
        });
        return;
      } catch {
        // 继续尝试下一个端口
      }
    }
    
    this._view?.webview.postMessage({
      type: 'serverStatus',
      payload: { connected: false }
    });
  }

  /**
   * 显示反馈请求
   */
  private _showFeedbackRequest(request: FeedbackRequest) {
      if (this._view) {
        this._view.show?.(true);
        this._view.webview.postMessage({
          type: 'showFeedbackRequest',
        payload: {
          requestId: request.id,
          summary: request.summary,
          projectDir: request.projectDir,
          timeout: request.timeout,
          timestamp: request.timestamp
        }
      });
    }
  }

  /**
   * 显示等待状态
   */
  private _showWaitingState() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'showWaiting'
      });
    }
  }

  /**
   * 处理反馈提交
   */
  private async _handleFeedbackSubmit(payload: {
    requestId: string;
    interactive_feedback: string;
    images: Array<{ name: string; data: string; size: number }>;
    attachedFiles: string[];
    project_directory: string;
  }) {
    // 使用活跃端口提交反馈
    const port = this._activePort || this._basePort;
    
    try {
      const response = await this._httpPost(
        `http://127.0.0.1:${port}/api/feedback/submit`,
        JSON.stringify({
          requestId: payload.requestId,
          feedback: {
            interactive_feedback: payload.interactive_feedback,
            images: payload.images,
            attachedFiles: payload.attachedFiles || [],
            project_directory: payload.project_directory
          }
        })
      );

      const result = JSON.parse(response);
      if (result.success) {
        vscode.window.showInformationMessage('反馈已提交');
        this._currentRequest = null;
        this._showWaitingState();
      } else {
        vscode.window.showErrorMessage('提交失败：' + result.error);
      }
    } catch (error) {
      vscode.window.showErrorMessage('提交失败：无法连接到 MCP Server');
    }
  }

  /**
   * 处理选择文件
   */
  private async _handleSelectFile() {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: '选择文件'
    });
    
    if (result && result.length > 0) {
      const paths = result.map(uri => uri.fsPath);
      this._view?.webview.postMessage({
        type: 'filesSelected',
        payload: { paths, isFolder: false }
      });
    }
  }

  /**
   * 处理选择文件夹
   */
  private async _handleSelectFolder() {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: '选择文件夹'
    });
    
    if (result && result.length > 0) {
      const paths = result.map(uri => uri.fsPath);
      this._view?.webview.postMessage({
        type: 'filesSelected',
        payload: { paths, isFolder: true }
      });
    }
  }

  /**
   * HTTP GET 请求
   */
  private _httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * HTTP POST 请求
   */
  private _httpPost(url: string, body: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 5000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const config = vscode.workspace.getConfiguration('cursorFeedback');
    const language = config.get<string>('language', 'zh-CN');

    const i18n = this._getI18n(language);

    // 获取本地 marked.js 文件的 URI
    const markedJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'vendor', 'marked.min.js')
    );
    
    return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource}; img-src data:;">
  <title>Cursor Feedback</title>
  <!-- 使用本地 marked.js 进行 Markdown 渲染 -->
  <script src="${markedJsUri}"></script>
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
      min-height: 100vh;
    }
    
    .container {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    .section {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 12px;
    }
    
    .section-title {
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .summary-content {
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
      font-size: 13px;
      line-height: 1.6;
      background: var(--vscode-textBlockQuote-background);
      padding: 12px;
      border-radius: 4px;
    }
    
    /* Markdown 样式 */
    .summary-content h1, .summary-content h2, .summary-content h3 {
      margin-top: 12px;
      margin-bottom: 8px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .summary-content h1 { font-size: 1.4em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .summary-content h2 { font-size: 1.2em; }
    .summary-content h3 { font-size: 1.1em; }
    .summary-content h1:first-child, .summary-content h2:first-child, .summary-content h3:first-child { margin-top: 0; }
    
    .summary-content p { margin: 8px 0; }
    .summary-content ul, .summary-content ol { margin: 8px 0; padding-left: 20px; }
    .summary-content li { margin: 4px 0; }
    
    .summary-content code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 0.9em;
    }
    
    .summary-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .summary-content pre code {
      background: none;
      padding: 0;
    }
    
    .summary-content blockquote {
      border-left: 3px solid var(--vscode-textLink-foreground);
      margin: 8px 0;
      padding: 4px 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .summary-content table {
      border-collapse: collapse;
      margin: 8px 0;
      width: 100%;
    }
    .summary-content th, .summary-content td {
      border: 1px solid var(--vscode-panel-border);
      padding: 6px 10px;
      text-align: left;
    }
    .summary-content th {
      background: var(--vscode-textCodeBlock-background);
    }
    
    .summary-content strong { font-weight: 600; }
    .summary-content em { font-style: italic; }
    .summary-content a { color: var(--vscode-textLink-foreground); }
    .summary-content hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
    
    .feedback-input {
      width: 100%;
      min-height: 120px;
      resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      padding: 10px;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.5;
    }
    
    .feedback-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    
    .submit-btn {
      width: 100%;
      padding: 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 14px;
      transition: background 0.15s;
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
      padding: 30px 20px;
      color: var(--vscode-descriptionForeground);
    }
    
    .status-icon {
      font-size: 32px;
      margin-bottom: 12px;
    }
    
    .status.waiting .status-icon {
      animation: pulse 2s ease-in-out infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .server-status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      padding: 6px 10px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      margin-bottom: 12px;
    }
    
    .server-status .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-errorForeground);
    }
    
    .server-status.connected .dot {
      background: var(--vscode-notificationsInfoIcon-foreground);
    }
    
    .attachments-area {
      margin-top: 10px;
    }
    
    .attachment-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
    }
    
    .attachment-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    
    .attachment-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .file-list {
      margin-top: 8px;
    }
    
    .file-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      margin-bottom: 4px;
      font-size: 11px;
    }
    
    .file-item .file-icon {
      flex-shrink: 0;
    }
    
    .file-item .file-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
    }
    
    .file-item .file-remove {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--vscode-errorForeground);
      color: white;
      border: none;
      cursor: pointer;
      font-size: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .image-preview {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    
    .image-preview-item {
      position: relative;
    }
    
    .image-preview img {
      max-width: 80px;
      max-height: 80px;
      border-radius: 4px;
      object-fit: cover;
      border: 1px solid var(--vscode-input-border);
    }
    
    .image-remove {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--vscode-errorForeground);
      color: white;
      border: none;
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .hidden {
      display: none !important;
    }
    
    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      gap: 12px;
    }
    
    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--vscode-input-border);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .loading-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .project-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 6px;
      padding: 6px 8px;
      background: var(--vscode-textBlockQuote-background);
      border-radius: 4px;
      word-break: break-all;
    }
    
    .timeout-info {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      text-align: right;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <!-- Loading 状态 -->
  <div id="loadingContainer" class="loading-container">
    <div class="loading-spinner"></div>
    <div class="loading-text">${i18n.loading}</div>
  </div>
  
  <div id="mainContainer" class="container hidden">
    <!-- 服务器状态 -->
    <div id="serverStatus" class="server-status">
      <span class="dot"></span>
      <span id="serverStatusText">${i18n.checking}</span>
    </div>
    
    <!-- 等待状态 -->
    <div id="waitingStatus" class="status waiting">
      <div class="status-icon">⏳</div>
      <p>${i18n.waiting}</p>
      <p style="font-size: 11px; margin-top: 10px; opacity: 0.8;">${i18n.waitingHint}</p>
    </div>
    
    <!-- 反馈表单 -->
    <div id="feedbackForm" class="hidden">
      <!-- AI 摘要 -->
      <div class="section">
        <div class="section-title">📋 ${i18n.summary}</div>
        <div id="summaryContent" class="summary-content"></div>
        <div id="projectInfo" class="project-info"></div>
      </div>
      
      <!-- 反馈输入 -->
      <div class="section">
        <div class="section-title">💬 ${i18n.yourFeedback}</div>
        <textarea 
          id="feedbackInput" 
          class="feedback-input" 
          placeholder="${i18n.placeholder}"
        ></textarea>
        
        <!-- 附件区域 -->
        <div class="attachments-area">
          <div class="attachment-buttons">
            <button id="uploadBtn" class="attachment-btn" title="${i18n.uploadImage}">
              🖼️
            </button>
            <button id="selectFileBtn" class="attachment-btn" title="${i18n.selectFile}">
              📄
            </button>
            <button id="selectFolderBtn" class="attachment-btn" title="${i18n.selectFolder}">
              📁
            </button>
          </div>
          <input type="file" id="imageInput" accept="image/*" multiple style="display:none">
          <div id="imagePreview" class="image-preview"></div>
          <div id="fileList" class="file-list"></div>
        </div>
        
        <div id="timeoutInfo" class="timeout-info"></div>
      </div>
      
      <!-- 提交按钮 -->
      <button id="submitBtn" class="submit-btn">${i18n.submit} (Ctrl+Enter)</button>
    </div>
  </div>
  
  <script>
    // 初始化时隐藏 loading 显示主内容
    function hideLoading() {
      const loadingContainer = document.getElementById('loadingContainer');
      const mainContainer = document.getElementById('mainContainer');
      if (loadingContainer) loadingContainer.classList.add('hidden');
      if (mainContainer) mainContainer.classList.remove('hidden');
    }
  </script>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    // 使用 marked.js 渲染 Markdown
    function renderMarkdown(text) {
      if (!text) return '';
      
      try {
        // 配置 marked
        if (typeof marked !== 'undefined') {
          marked.setOptions({
            breaks: true,       // 支持 GitHub 风格的换行
            gfm: true,          // 启用 GitHub 风格 Markdown
            headerIds: false,   // 禁用标题 ID（安全考虑）
          });
          
          // 使用 marked 解析
          return marked.parse(text);
        }
      } catch (e) {
        console.error('Markdown rendering error:', e);
      }
      
      // 降级：简单转义并保留换行
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\\n/g, '<br>');
    }
    
    // DOM 元素
    const serverStatus = document.getElementById('serverStatus');
    const serverStatusText = document.getElementById('serverStatusText');
    const waitingStatus = document.getElementById('waitingStatus');
    const feedbackForm = document.getElementById('feedbackForm');
    const summaryContent = document.getElementById('summaryContent');
    const projectInfo = document.getElementById('projectInfo');
    const feedbackInput = document.getElementById('feedbackInput');
    const submitBtn = document.getElementById('submitBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    const selectFileBtn = document.getElementById('selectFileBtn');
    const selectFolderBtn = document.getElementById('selectFolderBtn');
    const imageInput = document.getElementById('imageInput');
    const imagePreview = document.getElementById('imagePreview');
    const fileList = document.getElementById('fileList');
    const timeoutInfo = document.getElementById('timeoutInfo');
    
    let uploadedImages = [];
    let attachedFiles = [];
    let currentRequestId = '';
    let currentProjectDir = '';
    let requestTimestamp = 0;
    let requestTimeout = 300;
    let countdownInterval = null;
    
    // 国际化文本
    const i18n = ${JSON.stringify(i18n)};
    
    
    // 图片上传
    uploadBtn.addEventListener('click', () => imageInput.click());
    
    // 选择文件
    selectFileBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectFile' });
    });
    
    // 选择文件夹
    selectFolderBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectFolder' });
    });
    
    // 添加已选文件到列表
    function addAttachedFile(path, isFolder) {
      if (attachedFiles.includes(path)) return;
      attachedFiles.push(path);
      
      const item = document.createElement('div');
      item.className = 'file-item';
      
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = isFolder ? '📁' : '📄';
      
      const pathSpan = document.createElement('span');
      pathSpan.className = 'file-path';
      pathSpan.textContent = path;
      pathSpan.title = path;
      
      const removeBtn = document.createElement('button');
      removeBtn.className = 'file-remove';
      removeBtn.textContent = '×';
      removeBtn.onclick = () => {
        const idx = attachedFiles.indexOf(path);
        if (idx > -1) attachedFiles.splice(idx, 1);
        item.remove();
      };
      
      item.appendChild(icon);
      item.appendChild(pathSpan);
      item.appendChild(removeBtn);
      fileList.appendChild(item);
    }
    
    imageInput.addEventListener('change', (e) => {
      const files = e.target.files;
      for (const file of files) {
        addImageFile(file);
      }
    });
    
    // 添加图片文件到预览和上传列表
    function addImageFile(file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target.result;
        const imgData = {
          name: file.name || ('pasted-image-' + Date.now() + '.png'),
          data: base64.split(',')[1],
          size: file.size
        };
        uploadedImages.push(imgData);
        
        // 显示预览
        const container = document.createElement('div');
        container.className = 'image-preview-item';
        
        const img = document.createElement('img');
        img.src = base64;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'image-remove';
        removeBtn.textContent = '×';
        removeBtn.onclick = () => {
          const index = uploadedImages.indexOf(imgData);
          if (index > -1) {
            uploadedImages.splice(index, 1);
          }
          container.remove();
        };
        
        container.appendChild(img);
        container.appendChild(removeBtn);
        imagePreview.appendChild(container);
      };
      reader.readAsDataURL(file);
    }
    
    // 粘贴图片支持 (Ctrl+V / Cmd+V)
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            addImageFile(file);
          }
        }
      }
    });
    
    // 更新倒计时
    function updateCountdown() {
      if (!requestTimestamp || !requestTimeout) return;
      
      const elapsed = Math.floor((Date.now() - requestTimestamp) / 1000);
      const remaining = Math.max(0, requestTimeout - elapsed);
      const minutes = Math.floor(remaining / 60);
      const seconds = remaining % 60;
      
      timeoutInfo.textContent = i18n.timeout + ': ' + minutes + ':' + seconds.toString().padStart(2, '0');
      
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        timeoutInfo.textContent = i18n.expired;
      }
    }
    
    // 提交反馈
    function submitFeedback() {
      const feedback = feedbackInput.value.trim();
      
      if (!currentRequestId) {
        return;
      }
      
      vscode.postMessage({
        type: 'submitFeedback',
        payload: {
          requestId: currentRequestId,
          interactive_feedback: feedback,
          images: uploadedImages,
          attachedFiles: attachedFiles,
          project_directory: currentProjectDir
        }
      });
      
      // 重置表单
      feedbackInput.value = '';
      uploadedImages = [];
      attachedFiles = [];
      imagePreview.innerHTML = '';
      fileList.innerHTML = '';
      currentRequestId = '';
      
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
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
          
          currentRequestId = message.payload.requestId;
          currentProjectDir = message.payload.projectDir;
          requestTimestamp = message.payload.timestamp;
          requestTimeout = message.payload.timeout;
          
          summaryContent.innerHTML = renderMarkdown(message.payload.summary);
          projectInfo.textContent = '📁 ' + message.payload.projectDir;
          feedbackInput.focus();
          
          // 启动倒计时
          if (countdownInterval) {
            clearInterval(countdownInterval);
          }
          updateCountdown();
          countdownInterval = setInterval(updateCountdown, 1000);
          break;
          
        case 'showWaiting':
          feedbackForm.classList.add('hidden');
          waitingStatus.classList.remove('hidden');
          
          if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          break;
          
        case 'serverStatus':
          if (message.payload.connected) {
            serverStatus.classList.add('connected');
            serverStatusText.textContent = i18n.connected;
          } else {
            serverStatus.classList.remove('connected');
            serverStatusText.textContent = i18n.disconnected;
          }
          break;
          
        case 'filesSelected':
          if (message.payload.paths) {
            for (const path of message.payload.paths) {
              addAttachedFile(path, message.payload.isFolder);
            }
          }
          break;
      }
    });
    
    // 定期检查服务器状态
    setInterval(() => {
      vscode.postMessage({ type: 'checkServer' });
    }, 5000);
    
    // 通知插件 WebView 已准备就绪
    vscode.postMessage({ type: 'ready' });
    vscode.postMessage({ type: 'checkServer' });
    
    // 隐藏 loading，显示主内容
    hideLoading();
  </script>
</body>
</html>`;
  }

  /**
   * 获取国际化文本
   */
  private _getI18n(lang: string): Record<string, string> {
    const translations: Record<string, Record<string, string>> = {
      'zh-CN': {
        loading: '加载中...',
        waiting: '等待 AI 请求反馈...',
        waitingHint: '当 AI 需要您的反馈时，这里会显示输入界面',
        summary: 'AI 工作摘要',
        yourFeedback: '您的反馈',
        placeholder: '请输入您的反馈...',
        uploadImage: '上传图片',
        selectFile: '选择文件',
        selectFolder: '选择文件夹',
        submit: '提交反馈',
        timeout: '剩余时间',
        expired: '已超时',
        checking: '检查连接...',
        connected: 'MCP Server 已连接',
        disconnected: 'MCP Server 未连接',
      },
      'zh-TW': {
        loading: '載入中...',
        waiting: '等待 AI 請求回饋...',
        waitingHint: '當 AI 需要您的回饋時，這裡會顯示輸入介面',
        summary: 'AI 工作摘要',
        yourFeedback: '您的回饋',
        placeholder: '請輸入您的回饋...',
        uploadImage: '上傳圖片',
        selectFile: '選擇檔案',
        selectFolder: '選擇資料夾',
        submit: '提交回饋',
        timeout: '剩餘時間',
        expired: '已超時',
        checking: '檢查連接...',
        connected: 'MCP Server 已連接',
        disconnected: 'MCP Server 未連接',
      },
      'en': {
        loading: 'Loading...',
        waiting: 'Waiting for AI feedback request...',
        waitingHint: 'The feedback interface will appear when AI needs your input',
        summary: 'AI Work Summary',
        yourFeedback: 'Your Feedback',
        placeholder: 'Enter your feedback...',
        uploadImage: 'Upload Image',
        selectFile: 'Select File',
        selectFolder: 'Select Folder',
        submit: 'Submit Feedback',
        timeout: 'Time remaining',
        expired: 'Expired',
        checking: 'Checking connection...',
        connected: 'MCP Server connected',
        disconnected: 'MCP Server disconnected',
      }
    };

    return translations[lang] || translations['zh-CN'];
  }
}
