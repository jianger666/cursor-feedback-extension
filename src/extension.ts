import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { loadMessages, getLanguage, I18nMessages } from './i18n';

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
        vscode.window.showInformationMessage(feedbackViewProvider.getMessage('startListening'));
      }
    })
  );

  // 注册命令：停止轮询
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.stopPolling', () => {
      if (feedbackViewProvider) {
        feedbackViewProvider.stopPolling();
        vscode.window.showInformationMessage(feedbackViewProvider.getMessage('stopListening'));
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
  private _portScanRange = 20; // 扫描端口范围
  private _seenRequestIds: Set<string> = new Set(); // 已处理过的请求 ID
  private _i18n: I18nMessages;
  private _debugInfo: {
    portRange: string;
    workspacePath: string;
    connectedPorts: number[]; // 所有窗口使用的端口
    activePort: number | null; // 当前项目监听的端口
    lastStatus: string;
  } = {
    portRange: '',
    workspacePath: '',
    connectedPorts: [],
    activePort: null,
    lastStatus: ''
  };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    port: number
  ) {
    this._basePort = port;
    this._debugInfo.portRange = `${port}-${port + this._portScanRange - 1}`;
    this._i18n = loadMessages(this._extensionUri.fsPath);
    this._debugInfo.lastStatus = this._i18n.checkingConnection;
  }

  /**
   * 获取翻译消息
   */
  public getMessage(key: keyof I18nMessages): string {
    return this._i18n[key] || key;
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
        case 'selectPath':
          await this._handleSelectPath();
          break;
        case 'switchLanguage':
          await this._handleSwitchLanguage();
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
   * 优化：如果已有活跃端口，先尝试该端口；失败则扫描所有端口
   */
  private async _pollForFeedbackRequest() {
    try {
      // 更新工作区路径
      const workspacePaths = getWorkspacePaths();
      this._debugInfo.workspacePath = workspacePaths.length > 0 ? workspacePaths[0] : '(无工作区)';
      const currentWorkspace = workspacePaths[0] || '';
      const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const normalizedCurrentWorkspace = normalize(currentWorkspace);

      // 如果有活跃端口，先尝试只轮询该端口
      if (this._activePort) {
        const result = await this._checkPortForRequest(this._activePort);
        
        // 检查是否仍然是我们的 Server
        if (result.connected) {
          const serverOwner = result.ownerWorkspace ? normalize(result.ownerWorkspace) : '';
          const isMyServer = !serverOwner || serverOwner === normalizedCurrentWorkspace;
          
          if (isMyServer) {
            // 端口仍然有效，保持使用
            this._debugInfo.connectedPorts = [this._activePort];
            this._debugInfo.activePort = this._activePort;
            
            if (result.request && !this._seenRequestIds.has(result.request.id)) {
              this._debugInfo.lastStatus = `监听端口 ${this._activePort}`;
              this._handleNewRequest(result.request, this._activePort);
              this._updateDebugInfo();
              return;
            }
            
            // 端口有效但无新请求，继续保持连接
            this._debugInfo.lastStatus = `监听端口 ${this._activePort}`;
            this._updateDebugInfo();
            return;
          }
        }
        
        // 活跃端口失效（连接失败或工作区不匹配），重置并扫描所有端口
        this._activePort = null;
        this._debugInfo.activePort = null;
      }

      // 扫描所有端口
      const ports = [];
      for (let i = 0; i < this._portScanRange; i++) {
        ports.push(this._basePort + i);
      }

      // 并行检查所有端口
      const results = await Promise.all(ports.map(port => this._checkPortForRequest(port)));
      
      // 更新已连接的端口列表
      this._debugInfo.connectedPorts = results.filter(r => r.connected).map(r => r.port);
      
      // 找出属于当前工作区的请求
      const myRequests = results.filter(r => {
        if (!r.request || this._seenRequestIds.has(r.request.id)) {
          return false;
        }
        const serverOwner = r.ownerWorkspace ? normalize(r.ownerWorkspace) : '';
        return !serverOwner || serverOwner === normalizedCurrentWorkspace;
      }).sort((a, b) => b.request!.timestamp - a.request!.timestamp);
      
      // 处理最新的请求
      if (myRequests.length > 0) {
        const newest = myRequests[0];
        this._activePort = newest.port;
        this._debugInfo.activePort = newest.port;
        this._debugInfo.lastStatus = `找到请求 (端口 ${newest.port})`;
        this._handleNewRequest(newest.request!, newest.port);
        this._updateDebugInfo();
        return;
      }

      // 没有新请求，检查是否有当前请求
      if (this._currentRequest && this._activePort) {
        this._debugInfo.activePort = this._activePort;
        this._debugInfo.lastStatus = `监听端口 ${this._activePort}`;
        this._updateDebugInfo();
        return;
      }
      
      // 没有任何请求
      this._debugInfo.activePort = null;
      
      if (this._debugInfo.connectedPorts.length === 0) {
        this._debugInfo.lastStatus = '未找到 MCP Server';
      } else {
        this._debugInfo.lastStatus = `已连接 ${this._debugInfo.connectedPorts.length} 个端口，等待请求`;
      }
      this._updateDebugInfo();
    } catch (error) {
      this._debugInfo.lastStatus = `轮询错误: ${error}`;
      this._updateDebugInfo();
    }
  }

  /**
   * 检查指定端口是否有反馈请求
   */
  private async _checkPortForRequest(port: number): Promise<{
    connected: boolean;
    request: FeedbackRequest | null;
    port: number;
    mismatch?: boolean; // 是否有请求但路径不匹配
    ownerWorkspace?: string | null; // Server 的所属工作区
    startTime?: number; // Server 的启动时间
  }> {
    try {
      // 带上工作区路径用于匹配
      const workspacePaths = getWorkspacePaths();
      const workspacePath = workspacePaths.length > 0 ? workspacePaths[0] : '';
      const url = `http://127.0.0.1:${port}/api/feedback/current?workspace=${encodeURIComponent(workspacePath)}`;
      const response = await this._httpGet(url);
      const parsed = JSON.parse(response);
      
      // 兼容新旧两种响应格式
      // 新格式: { request, ownerWorkspace, startTime }
      // 旧格式: FeedbackRequest | null
      let request: FeedbackRequest | null;
      let ownerWorkspace: string | null = null;
      let startTime: number = 0;
      
      if (parsed && typeof parsed === 'object' && 'startTime' in parsed) {
        // 新格式
        request = parsed.request;
        ownerWorkspace = parsed.ownerWorkspace;
        startTime = parsed.startTime;
      } else {
        // 旧格式（兼容 npm 上的旧版本）
        request = parsed as FeedbackRequest | null;
      }
      
      // 检查请求是否属于当前工作区
      if (request) {
        const isMatch = isPathInWorkspace(request.projectDir);
        
        if (!isMatch) {
          // 请求不属于当前工作区，返回特殊标记
          return { connected: true, request: null, port, mismatch: true, ownerWorkspace, startTime };
        }
      }
      
      return { connected: true, request, port, ownerWorkspace, startTime };
    } catch {
      return { connected: false, request: null, port };
    }
  }

  /**
   * 处理新的反馈请求
   */
  private _handleNewRequest(request: FeedbackRequest, port: number) {
    // 如果已经处理过这个请求，跳过
    if (this._seenRequestIds.has(request.id)) {
      return;
    }

    // 判断是否为"新鲜"请求：创建后 10 秒内被发现
    const requestAge = Date.now() - request.timestamp;
    const isFreshRequest = requestAge < 10000; // 10秒内
    
    console.log(`Feedback request on port ${port}:`, request.id, 
      `age: ${requestAge}ms, isFresh: ${isFreshRequest}`);
    
    // 标记为已见过
    this._seenRequestIds.add(request.id);
    
    // 清理旧的请求 ID（保留最近 100 个）
    if (this._seenRequestIds.size > 100) {
      const ids = Array.from(this._seenRequestIds);
      this._seenRequestIds = new Set(ids.slice(-50));
    }

    if (!this._currentRequest || request.id !== this._currentRequest.id) {
      this._currentRequest = request;
      this._activePort = port;
      
      // 显示请求内容
      this._showFeedbackRequest(request);
      
      // 只对新鲜请求自动聚焦和通知
      if (isFreshRequest) {
        vscode.commands.executeCommand('cursorFeedback.feedbackView.focus');
        vscode.window.showInformationMessage(this._i18n.aiWaitingFeedback);
      }
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
   * 更新调试信息到 WebView
   */
  private _updateDebugInfo() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'updateDebugInfo',
        payload: this._debugInfo
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
        vscode.window.showInformationMessage(this._i18n.feedbackSubmitted);
        this._currentRequest = null;
        this._showWaitingState();
      } else {
        vscode.window.showErrorMessage(this._i18n.submitFailed + ': ' + result.error);
      }
    } catch (error) {
      vscode.window.showErrorMessage(this._i18n.submitFailed + ': ' + this._i18n.cannotConnectMCP);
    }
  }

  /**
   * 处理选择文件/文件夹
   */
  private async _handleSelectPath() {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: this._i18n.select
    });
    
    if (result && result.length > 0) {
      const paths = result.map(uri => uri.fsPath);
      this._view?.webview.postMessage({
        type: 'filesSelected',
        payload: { paths }
      });
    }
  }

  /**
   * 处理语言切换
   */
  private async _handleSwitchLanguage() {
    const config = vscode.workspace.getConfiguration('cursorFeedback');
    const currentConfigLang = config.get<string>('language') || 'auto';
    
    const languages = [
      { label: '🌐 Auto (System)', value: 'auto', description: 'Detect from system language' },
      { label: '简体中文', value: 'zh-CN', description: '' },
      { label: 'English', value: 'en', description: '' }
    ];
    
    const selected = await vscode.window.showQuickPick(
      languages.map(l => ({
        label: l.label + (l.value === currentConfigLang ? ' ✓' : ''),
        description: l.description,
        value: l.value
      })),
      {
        placeHolder: 'Select Language / 选择语言'
      }
    );
    
    if (selected && selected.value !== currentConfigLang) {
      // 更新设置
      await config.update('language', selected.value, vscode.ConfigurationTarget.Global);
      
      // 重新加载 i18n（如果是 auto，需要重新检测）
      this._i18n = loadMessages(this._extensionUri.fsPath);
      
      // 重新渲染 WebView
      if (this._view) {
        this._view.webview.html = this._getHtmlForWebview(this._view.webview);
      }
      
      const effectiveLang = getLanguage();
      vscode.window.showInformationMessage(
        effectiveLang === 'en' 
          ? 'Language changed to English' 
          : '语言已切换为简体中文'
      );
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
    // 获取资源文件的 URI
    const markedJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'vendor', 'marked.min.js')
    );
    const stylesCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'styles.css')
    );
    const scriptJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'script.js')
    );

    // 读取 HTML 模板
    const htmlTemplatePath = path.join(this._extensionUri.fsPath, 'dist', 'webview', 'index.html');
    let htmlTemplate = fs.readFileSync(htmlTemplatePath, 'utf-8');

    // CSP 策略
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; img-src data:;`;

    // 获取语言设置
    const language = getLanguage();
    const langCode = language === 'zh-TW' ? 'zh-TW' : (language === 'en' ? 'en' : 'zh-CN');

    // 替换占位符
    htmlTemplate = htmlTemplate
      .replace(/\{\{CSP\}\}/g, csp)
      .replace(/\{\{LANG\}\}/g, langCode)
      .replace(/\{\{MARKED_JS_URI\}\}/g, markedJsUri.toString())
      .replace(/\{\{STYLES_CSS_URI\}\}/g, stylesCssUri.toString())
      .replace(/\{\{SCRIPT_JS_URI\}\}/g, scriptJsUri.toString())
      .replace(/\{\{I18N_JSON\}\}/g, JSON.stringify(this._i18n))
      .replace(/\{\{i18n\.(\w+)\}\}/g, (_, key) => {
        return (this._i18n as any)[key] || key;
      });

    return htmlTemplate;
  }
}
