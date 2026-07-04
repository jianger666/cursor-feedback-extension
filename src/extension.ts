import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { loadMessages, getLanguage, I18nMessages } from './i18n';

let feedbackViewProvider: FeedbackViewProvider | null = null;

/** 规范化路径：统一分隔符、去尾斜杠、转小写，用于工作区匹配 */
function normalizePath(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 两个已归一化的路径互为前缀（相等 / 一方是另一方的子目录）即视为同一窗口语境 */
function pathsRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

export function activate(context: vscode.ExtensionContext) {
  // 注册侧边栏 WebView（端口从 61927 开始自动扫描）
  feedbackViewProvider = new FeedbackViewProvider(context.extensionUri, 61927, context.globalState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'cursorFeedback.feedbackView',
      feedbackViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // 注册命令：显示反馈面板
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.showPanel', () => {
      vscode.commands.executeCommand('cursorFeedback.feedbackView.focus');
    })
  );

  // 注册 URI Handler：系统通知点击后通过 deep link（cursor://jianger666.cursor-feedback/focus）
  // 打开/聚焦 IDE 并定位到反馈面板
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === '/focus') {
          vscode.commands.executeCommand('cursorFeedback.feedbackView.focus');
        }
      }
    })
  );

  // 注册命令：启动轮询
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.startPolling', () => {
      if (feedbackViewProvider) {
        feedbackViewProvider.startPolling();
      }
    })
  );

  // 注册命令：停止轮询
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.stopPolling', () => {
      if (feedbackViewProvider) {
        feedbackViewProvider.stopPolling();
      }
    })
  );

  // 注册命令：带入编辑器选中代码到反馈输入框
  context.subscriptions.push(
    vscode.commands.registerCommand('cursorFeedback.insertSelection', () => {
      feedbackViewProvider?.insertSelectionToFeedback();
    })
  );

  // 缓存最近的活动编辑器（焦点在 feedback webview 时 activeTextEditor 会变 undefined）
  if (vscode.window.activeTextEditor) {
    feedbackViewProvider.setLastActiveEditor(vscode.window.activeTextEditor);
  }
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        feedbackViewProvider?.setLastActiveEditor(editor);
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

/** 忙时排队消息快照（server 随轮询下发，面板展示队列列表用） */
interface QueuedItem {
  id: string;
  at: number;
  source: 'feishu' | 'panel';
  text: string;
  images: number;
  files: number;
  /** 该队列项所在 server 的端口（extension 汇总时打标，撤回请求按它路由） */
  port?: number;
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
 * 检查路径是否匹配当前工作区
 * - 有工作区的窗口：接收匹配工作区路径的消息（相等或互为子目录——AI 传的
 *   project_directory 常是工作区的子目录，精确匹配会漏收，面板收不到、心跳也失配）
 * - 没有工作区的窗口：只接收没有指定项目路径的消息
 */
function isPathInWorkspace(targetPath: string): boolean {
  const workspacePaths = getWorkspacePaths();
  
  // 规范化路径（去除末尾斜杠，统一分隔符，小写）
  const normalizedTarget = normalizePath(targetPath);
  
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
    if (pathsRelated(normalizedTarget, normalizePath(wsPath))) {
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
  private _polling = false;
  private _pollTimer: NodeJS.Timeout | null = null;
  private _pollDelay = 1000;
  private _currentRequest: FeedbackRequest | null = null;
  // 当前请求所在的 server 端口：请求与端口强绑定。多项目多窗口时各 server 占不同端口，
  // 绝不能用 _activePort || basePort 兜底提交——activePort 被瞬时网络抖动置空后，
  // basePort 可能是别的项目的 server，提交过去就是 "Request not found"（用户反馈的 bug）。
  private _currentRequestPort: number | null = null;
  private _lastActiveEditor: vscode.TextEditor | undefined;
  // webview 脚本是否就绪；插入上下文消息需等就绪后再发，否则 focus 唤起重建时会丢消息
  private _webviewReady = false;
  private _pendingInsert: { type: string; payload?: any } | null = null;
  private _basePort: number;
  private _activePort: number | null = null;
  private _portScanRange = 20; // 扫描端口范围
  private _seenRequestIds: Set<string> = new Set(); // 见过的请求 ID（只用于「新鲜提醒」去重，不再挡显示）
  // 本窗口已提交 / 已被外部渠道结束的请求 ID：绝不复显。
  // 与 _seenRequestIds 分开的原因：同窗口多对话并存时（如一个等待被暂停、另一对话又发起新等待），
  // 被覆盖的旧请求在新请求结束后会重新从 server 返回，此时它虽「见过」但没提交过，必须能回到面板；
  // 旧实现用 seen 一刀切挡显示，旧请求就永远回不来了。
  private _resolvedRequestIds: Set<string> = new Set();
  private _i18n: I18nMessages;
  // 超时续期开关（由侧边栏按钮切换，随轮询同步给 MCP server）
  private _autoRetry: boolean = true;
  // 飞书配置（持久化在 globalState；secret 会回显给 webview，前端用小眼睛切换明文/掩码）
  private _feishuConfig: { appId: string; appSecret: string } = { appId: '', appSecret: '' };
  // 飞书绑定状态（运行时，来自轮询 server；绑定本身由 server 端磁盘持久化、多进程共享）
  private _feishuBound: boolean = false;
  // 飞书通知开关（用户可关：即使配置了凭证也不推飞书）
  private _feishuEnabled: boolean = true;
  // Get 表情回执子开关（飞书通知子项；关掉后用户飞书回复不加 Get 表情、也不发文字兜底）
  private _feishuAck: boolean = true;
  // 忙时消息排队子开关（飞书通知子项；AI 正忙时用户消息入队，下一轮 feedback 自动送达）
  private _feishuQueue: boolean = true;
  // 最近一次下发给 webview 的队列快照（签名去重避免每秒刷屏；webview 重建后凭此恢复列表）
  private _lastQueueSig = '';
  private _lastQueueItems: QueuedItem[] = [];
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
    port: number,
    private readonly _memento?: vscode.Memento
  ) {
    this._basePort = port;
    this._debugInfo.portRange = `${port}-${port + this._portScanRange - 1}`;
    this._i18n = loadMessages(this._extensionUri.fsPath);
    this._debugInfo.lastStatus = this._i18n.checkingConnection;
    this._autoRetry = this._memento?.get<boolean>('autoRetry', true) ?? true;
    // 凭证真相源在 server 端磁盘；这里从 globalState 读上次的值仅作首屏占位，poll 一到即被 server 覆盖。
    const fc = this._memento?.get<{ appId?: string; appSecret?: string }>('feishuConfig', {}) ?? {};
    this._feishuConfig = { appId: fc.appId || '', appSecret: fc.appSecret || '' };
    this._feishuEnabled = this._memento?.get<boolean>('feishuEnabled', true) ?? true;
    this._feishuAck = this._memento?.get<boolean>('feishuAck', true) ?? true;
    this._feishuQueue = this._memento?.get<boolean>('feishuQueue', true) ?? true;
  }

  /**
   * 获取翻译消息
   */
  public getMessage(key: keyof I18nMessages): string {
    return this._i18n[key] || key;
  }

  /** 翻译并替换 {占位符} 参数（用于带变量的状态文案） */
  private _t(key: keyof I18nMessages, params?: Record<string, string | number>): string {
    let s: string = this._i18n[key] || key;
    if (params) {
      for (const k of Object.keys(params)) {
        s = s.replace(`{${k}}`, String(params[k]));
      }
    }
    return s;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    this._webviewReady = false;

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
        case 'queueMessage':
          await this._handleQueueMessage(data.payload);
          break;
        case 'removeQueued':
          await this._handleRemoveQueued(data.payload);
          break;
        case 'ready':
          this._webviewReady = true;
          // 同步超时续期开关状态到 UI
          this._postAutoRetryState();
          this._postFeishuState();
          // 重建后的 webview 恢复队列列表显示（poll 之后每秒还会校准）
          this._view?.webview.postMessage({
            type: 'queueState',
            payload: { items: this._lastQueueItems }
          });
          // WebView 准备就绪后，检查是否有待处理的请求
          // （插件通知关闭时保持静默，不显示缓存的请求）
          if (this._currentRequest && this._isPluginNotifyEnabled()) {
            this._showFeedbackRequest(this._currentRequest);
          }
          // 补发就绪前排队的「插入上下文」消息
          this._flushPendingInsert();
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
        case 'toggleAutoRetry':
          await this._handleToggleAutoRetry();
          break;
        case 'togglePause':
          await this._handleTogglePause(data.payload);
          break;
        case 'searchFiles':
          await this._handleSearchFiles();
          break;
        case 'requestSelection':
          await this.insertSelectionToFeedback();
          break;
        case 'saveFeishuConfig':
          await this._handleSaveFeishuConfig(data.payload);
          break;
        case 'toggleFeishuEnabled':
          await this._handleToggleFeishuEnabled(!!data.payload?.enabled);
          break;
        case 'toggleSystemNotification':
          await this._handleToggleSystemNotification(!!data.payload?.enabled);
          break;
        case 'toggleOsNotification':
          await this._handleToggleOsNotification(!!data.payload?.enabled);
          break;
        case 'toggleFeishuAck':
          await this._handleToggleFeishuAck(!!data.payload?.enabled);
          break;
        case 'toggleFeishuQueue':
          await this._handleToggleFeishuQueue(!!data.payload?.enabled);
          break;
        case 'feishuRegisterStart':
          await this._handleFeishuRegisterStart();
          break;
        case 'feishuRegisterCancel':
          this._handleFeishuRegisterCancel();
          break;
        case 'openLink':
          this._handleOpenLink(data.payload?.url);
          break;
        case 'testNotification':
          this._sendTestNotification();
          break;
      }
    });

    // 当 view 变为可见时，检查当前请求
    // （插件通知关闭时保持静默：即使用户从侧边栏切回面板也不显示缓存的请求）
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this._currentRequest && this._isPluginNotifyEnabled()) {
        this._showFeedbackRequest(this._currentRequest);
      }
    });
  }

  /**
   * 开始轮询 MCP Server
   *
   * 自适应间隔：连上 server 时每秒轮询（兼作 server watchdog 心跳，必须 < 30s 空闲阈值）；
   * 完全找不到 server 时指数退避到最多 5s，降低空闲 CPU / 电池开销。
   * 一旦发现任意 server 立即恢复 1s。
   */
  public startPolling() {
    if (this._polling) {
      return;
    }
    this._polling = true;
    this._pollDelay = 1000;

    const loop = async () => {
      if (!this._polling) return;
      await this._pollForFeedbackRequest();
      if (!this._polling) return;
      // 没连上任何 server → 退避；连上了 → 保持 1s 心跳
      this._pollDelay = this._debugInfo.connectedPorts.length === 0
        ? Math.min(this._pollDelay + 1000, 5000)
        : 1000;
      this._pollTimer = setTimeout(loop, this._pollDelay);
    };
    loop();
  }

  /**
   * 停止轮询
   */
  public stopPolling() {
    this._polling = false;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
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
      this._debugInfo.workspacePath = workspacePaths.length > 0 ? workspacePaths[0] : this._t('statusNoWorkspace');
      const currentWorkspace = workspacePaths[0] || '';
      const normalizedCurrentWorkspace = normalizePath(currentWorkspace);

      // 如果有活跃端口，先尝试只轮询该端口
      if (this._activePort) {
        const result = await this._checkPortForRequest(this._activePort);
        
        // 检查是否仍然是我们的 Server。注意：多窗口/多对话共用一个 MCP 进程时，
        // server 的 ownerWorkspace（进程归属，单值）可能是别的窗口——但只要它按窗口
        // 返回了本工作区的请求（request 已在 _checkPortForRequest 里按 projectDir 过滤），
        // 这个端口对本窗口就是有效的，不能因 owner 不匹配而丢弃请求。
        if (result.connected) {
          const serverOwner = result.ownerWorkspace ? normalizePath(result.ownerWorkspace) : '';
          const isMyServer = !!result.request || !serverOwner || pathsRelated(serverOwner, normalizedCurrentWorkspace);
          
          if (isMyServer) {
            // 端口仍然有效，保持使用
            this._debugInfo.connectedPorts = [this._activePort];
            this._debugInfo.activePort = this._activePort;

            // 同步忙时队列快照到面板（签名去重，无变化不发）；打上端口标，撤回时按它路由
            this._postQueueState((result.queued || []).map(q => ({ ...q, port: this._activePort! })));
            
            // 只挡「已提交/已结束」的请求；_handleNewRequest 内部按当前显示态去重，重复调用无害
            if (result.request && !this._resolvedRequestIds.has(result.request.id)) {
              this._debugInfo.lastStatus = this._t('statusListening', { port: this._activePort });
              this._handleNewRequest(result.request, this._activePort);
              this._updateDebugInfo();
              return;
            }

            // 正在显示的请求被「飞书回复」结束 → 重置面板，避免提交到已消失的请求。
            // 仅当 server 明确标记该请求是被飞书 resolve 的才重置——超时续期时 request 也会短暂为 null，
            // 但 feishuResolvedId 不会命中，于是保持原有等待逻辑，不误重置、不丢用户草稿。
            if (this._currentRequest && result.feishuResolvedId === this._currentRequest.id) {
              this._handleExternalResolve();
            }
            
            // 端口有效但无新请求，继续保持连接
            this._debugInfo.lastStatus = this._t('statusListening', { port: this._activePort });
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

      // 汇总各 server 返回的本工作区忙时队列（正常只有归属本窗口的 server 有内容），按时间排序下发；
      // 打上各自 server 的端口标，撤回时按它路由
      const queuedAll = results
        .flatMap(r => (r.connected && Array.isArray(r.queued) ? r.queued.map(q => ({ ...q, port: r.port })) : []))
        .sort((a, b) => a.at - b.at);
      this._postQueueState(queuedAll);
      
      // 找出属于当前工作区的请求（只排除已提交/已结束的；「见过但没提交」的仍要能回到面板）。
      // 不再用 server 进程级 ownerWorkspace 二次过滤：request 已在 _checkPortForRequest
      // 按本窗口工作区过滤过（isPathInWorkspace）；多窗口共用一个 MCP 进程时 owner 只反映
      // 首个对话的窗口，按它过滤会把其他窗口的请求全部滤掉（面板不显示、只有飞书收到）。
      const myRequests = results
        .filter(r => !!r.request && !this._resolvedRequestIds.has(r.request.id))
        .sort((a, b) => b.request!.timestamp - a.request!.timestamp);
      
      // 处理最新的请求
      if (myRequests.length > 0) {
        const newest = myRequests[0];
        this._activePort = newest.port;
        this._debugInfo.activePort = newest.port;
        this._debugInfo.lastStatus = this._t('statusFound', { port: newest.port });
        this._handleNewRequest(newest.request!, newest.port);
        this._updateDebugInfo();
        return;
      }

      // 找回当前请求所在的端口：活跃端口被瞬时抖动重置后，当前请求的 id 已进 _seenRequestIds、
      // 不会再出现在 myRequests 里，必须从扫描结果里按 id 找回，否则提交会 fallback 到
      // basePort——多项目时那可能是别的项目的 server，导致 "Request not found"。
      if (this._currentRequest && !this._activePort) {
        const cur = this._currentRequest;
        const holder = results.find(r => r.connected && r.request && r.request.id === cur.id);
        if (holder) {
          this._activePort = holder.port;
          this._currentRequestPort = holder.port;
        }
      }

      // 没有新请求，检查是否有当前请求
      if (this._currentRequest && this._activePort) {
        this._debugInfo.activePort = this._activePort;
        this._debugInfo.lastStatus = this._t('statusListening', { port: this._activePort });
        this._updateDebugInfo();
        return;
      }
      
      // 没有任何请求
      this._debugInfo.activePort = null;
      
      if (this._debugInfo.connectedPorts.length === 0) {
        this._debugInfo.lastStatus = this._t('statusNoServer');
      } else {
        this._debugInfo.lastStatus = this._t('statusConnected', { count: this._debugInfo.connectedPorts.length });
      }
      this._updateDebugInfo();
    } catch (error) {
      this._debugInfo.lastStatus = this._t('statusPollError', { error: String(error) });
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
    feishuResolvedId?: string | null; // server 标记的「最近被飞书回复」的请求 id
    queued?: QueuedItem[]; // 本工作区的忙时排队消息快照
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
      let feishuResolvedId: string | null = null;
      let queued: QueuedItem[] = [];
      
      if (parsed && typeof parsed === 'object' && 'startTime' in parsed) {
        // 新格式
        request = parsed.request;
        ownerWorkspace = parsed.ownerWorkspace;
        feishuResolvedId = parsed.feishuResolvedId ?? null;
        if (Array.isArray(parsed.queued)) queued = parsed.queued;
        this._maybeSyncFeishu(port, parsed.feishu);
        this._maybeSyncAutoRetry(parsed.autoRetry);
        this._maybeSyncPause(parsed.pause);
      } else {
        // 旧格式（兼容 npm 上的旧版本）
        request = parsed as FeedbackRequest | null;
      }
      
      // 检查请求是否属于当前工作区
      if (request) {
        const isMatch = isPathInWorkspace(request.projectDir);
        
        if (!isMatch) {
          // 请求不属于当前工作区，返回特殊标记
          return { connected: true, request: null, port, mismatch: true, ownerWorkspace, queued };
        }
      }
      
      return { connected: true, request, port, ownerWorkspace, feishuResolvedId, queued };
    } catch {
      return { connected: false, request: null, port };
    }
  }

  /**
   * 处理新的反馈请求。
   * 幂等：同一请求正在显示时重复调用直接跳过；已提交/已结束的绝不复显；
   * 「见过但没提交」的请求（同窗口多对话时被新请求覆盖过）允许重新显示，只是不再重复提醒。
   */
  private _handleNewRequest(request: FeedbackRequest, port: number) {
    // 已提交 / 已被外部渠道结束 → 绝不复显（防旧版 server 的 currentRequest 清理滞后导致复弹）
    if (this._resolvedRequestIds.has(request.id)) {
      return;
    }
    // 正在显示的就是它 → 无事可做
    if (this._currentRequest && request.id === this._currentRequest.id) {
      return;
    }

    // 判断是否为"新鲜"请求：创建后 10 秒内被发现
    const requestAge = Date.now() - request.timestamp;
    const isFreshRequest = requestAge < 10000; // 10秒内

    // seen 只用于「主动提醒」去重：同一请求只 focus / 系统通知一次，重新回到面板时安静显示
    const alreadySeen = this._seenRequestIds.has(request.id);
    this._seenRequestIds.add(request.id);

    // 清理旧的请求 ID（保留最近 100 个）
    if (this._seenRequestIds.size > 100) {
      const ids = Array.from(this._seenRequestIds);
      this._seenRequestIds = new Set(ids.slice(-50));
    }
    if (this._resolvedRequestIds.size > 100) {
      const ids = Array.from(this._resolvedRequestIds);
      this._resolvedRequestIds = new Set(ids.slice(-50));
    }

    this._currentRequest = request;
    this._activePort = port;
    this._currentRequestPort = port;

    // 「插件通知」主开关（配置 key 历史原因仍叫 systemNotification）：关掉后本窗口完全静默——
    // 不推送内容、不弹面板、不抢焦点、不发系统通知；连用户之后主动切回 / 打开面板也不显示
    // （见 resolveWebviewView 里 ready 与 onDidChangeVisibility 的同款判断）。
    // 请求仍记录在 _currentRequest，仅用于去重与外部渠道（飞书 / 超时）resolve 关联。
    if (!this._isPluginNotifyEnabled()) {
      return;
    }

    // 推送内容并显示面板
    this._showFeedbackRequest(request);

    // 只对「新鲜且首次见到」的请求做主动提醒（聚焦面板 + IDE 提示 + 失焦系统通知）
    if (isFreshRequest && !alreadySeen) {
      vscode.commands.executeCommand('cursorFeedback.feedbackView.focus');
      this._sendSystemNotification(request);
    }
  }

  /**
   * 发送系统级通知（macOS / Windows / Linux）
   * 
   * 场景：AI 运行较久时用户可能切去做别的事，IDE 内部的提示看不到，
   * 等回来时反馈请求已超时。系统通知可以在 IDE 失焦时及时提醒用户回来。
   * 
   * 仅在 IDE 窗口未聚焦时发送——窗口聚焦时 IDE 内部提示已足够，
   * 避免每轮对话都弹系统通知造成打扰。
   */
  private _sendSystemNotification(request: FeedbackRequest) {
    const config = vscode.workspace.getConfiguration('cursorFeedback');
    if (!config.get<boolean>('systemNotification', true)) {
      return;
    }

    // 子开关「失焦时系统提示」：关掉后即使窗口失焦也不弹系统通知
    if (!config.get<boolean>('osNotification', true)) {
      return;
    }

    if (vscode.window.state.focused) {
      return;
    }

    const projectName = path.basename(request.projectDir || '')
      || vscode.workspace.workspaceFolders?.[0]?.name
      || '';
    const title = projectName ? `Cursor Feedback · ${projectName}` : 'Cursor Feedback';
    this._fireOsNotification(title, this._i18n.aiWaitingFeedback);
  }

  /**
   * 发送测试通知（设置弹窗里的「发送测试通知」按钮）：
   * 绕过开关与失焦判断，让用户随时一键验证系统通知链路是否通（含权限被拒排查）。
   */
  private _sendTestNotification() {
    this._fireOsNotification('Cursor Feedback', this._i18n.notifyTestBody);
  }

  /** 真正发系统通知的平台分支（macOS / Windows / Linux） */
  private _fireOsNotification(title: string, body: string) {
    const config = vscode.workspace.getConfiguration('cursorFeedback');
    const withSound = config.get<boolean>('notificationSound', true);
    // 点击通知的 deep link：唤起 IDE（Cursor 为 cursor://，VSCode 为 vscode://）并聚焦反馈面板。
    // 由 activate() 里注册的 UriHandler 处理 /focus 路径。
    const deepLink = `${vscode.env.uriScheme}://jianger666.cursor-feedback/focus`;

    try {
      if (process.platform === 'darwin') {
        // 点击通知打开 deep link 依赖 terminal-notifier（osascript 通知点击无法挂动作，系统限制）。
        // 插件内置了一份（resources/terminal-notifier.app，x86_64，Apple Silicon 走 Rosetta），
        // 用户零安装即可用；内置的跑不起来（如无 Rosetta）→ 试 PATH 里 brew 装的原生版 → 最后
        // 回退 osascript（通知照弹，只是点击无动作）。
        const tnArgs = ['-title', title, '-message', body, '-open', deepLink];
        if (withSound) tnArgs.push('-sound', 'Glass');
        const bundledTn = vscode.Uri.joinPath(
          this._extensionUri,
          'resources', 'terminal-notifier.app', 'Contents', 'MacOS', 'terminal-notifier'
        ).fsPath;
        const fallbackOsascript = () => {
          // AppleScript 字符串转义（execFile 不经过 shell，无注入风险）
          const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          let script = `display notification "${esc(body)}" with title "${esc(title)}"`;
          if (withSound) {
            script += ' sound name "Glass"';
          }
          execFile('osascript', ['-e', script], () => {});
        };
        // vsix 解包可能丢失可执行位，先补一把（失败无妨，走后续回退）
        try { fs.chmodSync(bundledTn, 0o755); } catch { /* ignore */ }
        execFile(bundledTn, tnArgs, (err) => {
          if (!err) return;
          execFile('terminal-notifier', tnArgs, (err2) => {
            if (!err2) return;
            fallbackOsascript();
          });
        });
      } else if (process.platform === 'win32') {
        // PowerShell 单引号字符串转义
        const esc = (s: string) => s.replace(/'/g, "''");
        // 使用 PowerShell 已注册的 AppId，未注册的 AppId 在 Win10/11 上会静默失败
        const appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
        const psScript = [
          '$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime];',
          '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
          "$texts = $template.GetElementsByTagName('text');",
          `$null = $texts.Item(0).AppendChild($template.CreateTextNode('${esc(title)}'));`,
          `$null = $texts.Item(1).AppendChild($template.CreateTextNode('${esc(body)}'));`,
          // 点击 toast 通过 protocol 激活 deep link，把 IDE 带回前台并聚焦反馈面板
          `$template.DocumentElement.SetAttribute('activationType', 'protocol');`,
          `$template.DocumentElement.SetAttribute('launch', '${esc(deepLink)}');`,
          ...(withSound ? [] : [
            "$audio = $template.CreateElement('audio');",
            "$audio.SetAttribute('silent', 'true');",
            '$null = $template.DocumentElement.AppendChild($audio);'
          ]),
          '$toast = [Windows.UI.Notifications.ToastNotification]::new($template);',
          `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${esc(appId)}').Show($toast);`
        ].join(' ');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript], () => {});
      } else {
        // Linux：依赖 notify-send（GNOME/KDE 等主流桌面均自带），缺失时静默忽略
        execFile('notify-send', ['-u', 'normal', title, body], () => {});
      }
    } catch (error) {
      // 系统通知失败不影响主流程
      console.error('Failed to send system notification:', error);
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
   * 「插件通知」主开关是否开启（配置 key 历史原因仍叫 systemNotification）。
   * 关闭即本窗口完全静默：不主动推送，被动切回 / ready 时也不显示缓存的请求。
   */
  private _isPluginNotifyEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('cursorFeedback')
      .get<boolean>('systemNotification', true);
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
          summary: this._inlineLocalImages(request.summary),
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
   * 当前请求在 server 端被外部渠道结束（如飞书回复 / 超时）→ 重置面板，
   * 防止用户对着已消失的请求提交，导致 "Request not found"。
   */
  private _handleExternalResolve() {
    if (!this._currentRequest) return;
    this._seenRequestIds.add(this._currentRequest.id);
    this._resolvedRequestIds.add(this._currentRequest.id);
    this._currentRequest = null;
    this._currentRequestPort = null;
    this._showWaitingState();
    this._view?.webview.postMessage({ type: 'externalResolved' });
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
    // 提交到「当前请求所属」的端口：请求与端口强绑定，绝不能退回 basePort——
    // 多项目同时触发时 basePort 可能是别的项目的 server，会得到 "Request not found"
    const port = this._currentRequestPort || this._activePort || this._basePort;

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
        // 记入「已提交」：该请求此后绝不复显（server 端清理有滞后，轮询可能还会拿到它）
        this._resolvedRequestIds.add(payload.requestId);
        this._currentRequest = null;
        this._currentRequestPort = null;
        this._showWaitingState();
        // 提交结果轻提示：区分「已直接送达」与「撞上超时空窗、已暂存待下一轮」，
        // 让用户确定反馈发出去了（webview 同时借此把本次提交写入历史记录）
        this._view?.webview.postMessage({
          type: 'feedbackSubmitted',
          payload: { queued: !!result.queued }
        });
      } else {
        vscode.window.showErrorMessage(this._i18n.submitFailed + ': ' + result.error);
      }
    } catch (error) {
      vscode.window.showErrorMessage(this._i18n.submitFailed + ': ' + this._i18n.cannotConnectMCP);
    }
  }

  /**
   * 把忙时队列快照推给 webview（签名去重：队列无变化时每秒轮询不重复发）
   */
  private _postQueueState(items: QueuedItem[]) {
    const sig = JSON.stringify(items);
    if (sig === this._lastQueueSig) return;
    this._lastQueueSig = sig;
    this._lastQueueItems = items;
    this._view?.webview.postMessage({ type: 'queueState', payload: { items } });
  }

  /**
   * 面板忙时排队：AI 正忙（没有等待中的反馈请求）时用户在面板点了「排队发送」。
   * 先定位归属本工作区的 server（AI 的下一轮 interactive_feedback 会走同一个 MCP 进程，
   * 队列必须排在那里才能被消费），再 POST 入队。找不到归属 server = AI 没在本项目工作，
   * 明确告知失败，绝不静默吞消息。
   */
  private async _handleQueueMessage(payload: {
    interactive_feedback: string;
    images: Array<{ name: string; data: string; size: number }>;
    attachedFiles: string[];
  }) {
    const workspacePaths = getWorkspacePaths();
    const workspacePath = workspacePaths.length > 0 ? workspacePaths[0] : '';
    const fail = (reason: string) => {
      this._view?.webview.postMessage({ type: 'queueSubmitted', payload: { success: false, reason } });
    };
    if (!workspacePath) {
      fail('no-server');
      return;
    }
    const port = await this._findOwnerPort(workspacePath);
    if (!port) {
      fail('no-server');
      return;
    }
    try {
      const response = await this._httpPost(
        `http://127.0.0.1:${port}/api/feedback/enqueue`,
        JSON.stringify({
          text: payload.interactive_feedback,
          images: payload.images || [],
          attachedFiles: payload.attachedFiles || [],
          projectDir: workspacePath
        })
      );
      const result = JSON.parse(response);
      if (result.queued) {
        this._view?.webview.postMessage({ type: 'queueSubmitted', payload: { success: true } });
      } else {
        fail(result.reason === 'pending' || result.reason === 'disabled' ? result.reason : 'no-server');
      }
    } catch {
      fail('no-server');
    }
  }

  /**
   * 撤回一条排队消息：按队列项携带的端口路由到所在 server。
   * webview 已做乐观移除；失败也无需提示——下一秒轮询会把仍在队列里的消息补回列表。
   */
  private async _handleRemoveQueued(payload: { id: string; port?: number }) {
    if (!payload || !payload.id || typeof payload.port !== 'number') return;
    try {
      await this._httpPost(
        `http://127.0.0.1:${payload.port}/api/feedback/queue/remove`,
        JSON.stringify({ id: payload.id })
      );
    } catch {
      // 静默：轮询会校准列表
    }
  }

  /**
   * 定位归属指定工作区的 MCP server 端口（ownerWorkspace 与工作区路径互为前缀）。
   * 优先试当前已知端口，避免全端口扫描；都不中再并行扫描全范围。
   */
  private async _findOwnerPort(workspacePath: string): Promise<number | null> {
    const normalizedWs = normalizePath(workspacePath);
    const isOwner = async (port: number): Promise<boolean> => {
      try {
        const response = await this._httpGet(
          `http://127.0.0.1:${port}/api/feedback/current?workspace=${encodeURIComponent(workspacePath)}`
        );
        const parsed = JSON.parse(response);
        const owner = parsed && parsed.ownerWorkspace ? normalizePath(parsed.ownerWorkspace) : '';
        return !!owner && pathsRelated(owner, normalizedWs);
      } catch {
        return false;
      }
    };
    const preferred = [this._currentRequestPort, this._activePort]
      .filter((p): p is number => typeof p === 'number');
    for (const p of preferred) {
      if (await isOwner(p)) return p;
    }
    const ports: number[] = [];
    for (let i = 0; i < this._portScanRange; i++) {
      const p = this._basePort + i;
      if (!preferred.includes(p)) ports.push(p);
    }
    const hits = await Promise.all(ports.map(async (p) => ((await isOwner(p)) ? p : null)));
    return hits.find((p): p is number => p !== null) ?? null;
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

  public setLastActiveEditor(editor: vscode.TextEditor) {
    this._lastActiveEditor = editor;
  }

  /**
   * 带入最近活动编辑器的选中代码（或整个文件）到反馈输入框
   */
  public async insertSelectionToFeedback() {
    const editor = this._lastActiveEditor || vscode.window.activeTextEditor;
    await vscode.commands.executeCommand('cursorFeedback.feedbackView.focus');
    if (!editor) {
      this._postOrQueue({ type: 'insertContextEmpty' });
      return;
    }
    const doc = editor.document;
    const sel = editor.selection;
    const filePath = doc.uri.fsPath;
    if (sel && !sel.isEmpty) {
      this._postOrQueue({
        type: 'insertContext',
        payload: {
          filePath,
          lang: doc.languageId,
          code: doc.getText(sel),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1
        }
      });
    } else {
      this._postOrQueue({
        type: 'filesSelected',
        payload: { paths: [filePath] }
      });
    }
  }

  /** 发送插入消息；若 webview 尚未就绪（focus 触发重建），先排队，待 ready 后补发 */
  private _postOrQueue(msg: { type: string; payload?: any }) {
    this._pendingInsert = msg;
    if (this._webviewReady) {
      this._flushPendingInsert();
    }
  }

  private _flushPendingInsert() {
    if (this._pendingInsert && this._view && this._webviewReady) {
      this._view.webview.postMessage(this._pendingInsert);
      this._pendingInsert = null;
    }
  }

  /**
   * 搜索工作区文件，回传给 webview 做 @ 引用选择
   */
  private async _handleSearchFiles() {
    try {
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,dist,out,build,.next,.cache,coverage}/**',
        1000
      );
      const files = uris.map(u => ({
        path: u.fsPath,
        name: u.path.split('/').pop() || u.fsPath,
        rel: vscode.workspace.asRelativePath(u)
      }));
      files.sort((a, b) => a.rel.length - b.rel.length);
      this._view?.webview.postMessage({ type: 'fileSearchResults', payload: { files } });
    } catch {
      this._view?.webview.postMessage({ type: 'fileSearchResults', payload: { files: [] } });
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
      
    }
  }

  /**
   * 切换超时续期开关（AI 超时后是否继续等待用户）
   */
  private async _handleToggleAutoRetry() {
    this._autoRetry = !this._autoRetry;
    await this._memento?.update('autoRetry', this._autoRetry);
    this._postAutoRetryState();
    this._broadcastAutoRetry();
  }

  /** 把续期开关 POST 给所有已连接 server（server 写同一份磁盘、全局一致、重启保留） */
  private _broadcastAutoRetry() {
    const ports = new Set<number>(this._debugInfo.connectedPorts || []);
    if (this._activePort) ports.add(this._activePort);
    const body = JSON.stringify({ autoRetry: this._autoRetry });
    for (const port of ports) {
      this._httpPost(`http://127.0.0.1:${port}/api/settings/autoRetry`, body).catch(() => {});
    }
  }

  /**
   * 把超时续期开关状态推给 WebView
   */
  private _postAutoRetryState() {
    this._view?.webview.postMessage({
      type: 'autoRetryState',
      payload: { enabled: this._autoRetry }
    });
  }

  /** 从 server poll 回读续期开关并回显到 UI（server 为真相源，单向同步，避免多窗口拉锯） */
  private _maybeSyncAutoRetry(v: unknown) {
    if (typeof v !== 'boolean' || v === this._autoRetry) return;
    this._autoRetry = v;
    this._memento?.update('autoRetry', v);
    this._postAutoRetryState();
  }

  /**
   * 暂停/恢复当前请求的超时倒计时：转发给 MCP server（真实计时器在 server 端），
   * server 确认后把最新暂停态回推 WebView 刷新显示。
   */
  private async _handleTogglePause(payload: { requestId?: string; paused?: boolean }) {
    const requestId = payload?.requestId;
    if (!requestId || typeof payload?.paused !== 'boolean') return;
    const port = this._currentRequestPort || this._activePort || this._basePort;
    try {
      const response = await this._httpPost(
        `http://127.0.0.1:${port}/api/feedback/pause`,
        JSON.stringify({ requestId, paused: payload.paused })
      );
      const result = JSON.parse(response);
      if (result.success) {
        this._view?.webview.postMessage({
          type: 'pauseState',
          payload: { requestId, paused: result.paused, remainingMs: result.remainingMs }
        });
      } else {
        // 请求已在 server 端结束（超时/被回复）→ 明确提示，不能静默：
        // 用户以为暂停成功离开，实际倒计时早没了，回来发现等待消失会一头雾水
        this._view?.webview.postMessage({
          type: 'toast',
          payload: { text: this._i18n.pauseFailedEnded }
        });
      }
    } catch {
      // server 不支持（旧版本）或未连接：静默降级，倒计时照常走
    }
  }

  /**
   * 轮询时把 server 的暂停态回推 WebView（server 为真相源；每秒校准一次，
   * 面板重建 / 切换侧边栏后也能恢复正确的暂停显示与剩余时间）
   */
  private _maybeSyncPause(pause: unknown) {
    if (!pause || typeof pause !== 'object') return;
    const p = pause as { requestId?: string; paused?: boolean; remainingMs?: number };
    if (!this._currentRequest || p.requestId !== this._currentRequest.id) return;
    this._view?.webview.postMessage({
      type: 'pauseState',
      payload: { requestId: p.requestId, paused: !!p.paused, remainingMs: p.remainingMs }
    });
  }

  /**
   * 把飞书配置状态推给 WebView（含 secret 明文，前端用小眼睛切换显示/隐藏）
   */
  private _postFeishuState() {
    const { appId, appSecret } = this._feishuConfig;
    const cfg = vscode.workspace.getConfiguration('cursorFeedback');
    const systemNotification = cfg.get<boolean>('systemNotification', true);
    const osNotification = cfg.get<boolean>('osNotification', true);
    this._view?.webview.postMessage({
      type: 'feishuState',
      payload: {
        appId,
        appSecret,
        hasSecret: !!appSecret,
        configured: !!(appId && appSecret),
        bound: this._feishuBound,
        feishuEnabled: this._feishuEnabled,
        feishuAck: this._feishuAck,
        feishuQueue: this._feishuQueue,
        systemNotification: !!systemNotification,
        osNotification: !!osNotification
      }
    });
  }

  /**
   * 处理保存飞书配置（来自 webview）
   * - 所见即生效：appId/secret 直接用输入框的值，删空就是删空（半填 = 凭证不全 = server 关闭）。
   * - appId 变化：本地先解绑（真相仍以 server 磁盘 / poll 回读为准）。
   */
  private async _handleSaveFeishuConfig(payload: { appId?: string; appSecret?: string }) {
    const appId = (payload?.appId || '').trim();
    const appSecret = (payload?.appSecret || '').trim();
    if (appId !== this._feishuConfig.appId) this._feishuBound = false;
    this._feishuConfig = { appId, appSecret };
    // 占位缓存（真相在 server 磁盘，poll 会回读覆盖）
    await this._memento?.update('feishuConfig', this._feishuConfig);
    // 下发给所有端口：server 写磁盘（全局真相源）+ configure；清空则下发空 → server 关闭 / 清空。
    this._broadcastFeishuConfig();
    this._postFeishuState();
  }

  /**
   * 轮询时把 server 的飞书状态同步到本地用于回显。
   * 凭证真相源在 server 端磁盘（跨窗口共享）：插件只读不回写，从根上消除多窗口「A 删 B 又补回」的拉锯。
   * 同步凭证 / 开关 / Get 表情 / 绑定，有变化才刷新面板。
   */
  private _maybeSyncFeishu(
    _port: number,
    feishuStatus:
      | {
          configured?: boolean;
          boundChatId?: string | null;
          appId?: string;
          appSecret?: string;
          enabled?: boolean;
          ackReaction?: boolean;
          queueWhenBusy?: boolean;
        }
      | undefined
  ) {
    if (!feishuStatus) return;
    const appId = feishuStatus.appId || '';
    const appSecret = feishuStatus.appSecret || '';
    const enabled = feishuStatus.enabled !== false;
    const ack = feishuStatus.ackReaction !== false;
    const queue = feishuStatus.queueWhenBusy !== false;
    const bound = !!feishuStatus.boundChatId;
    let changed = false;
    if (appId !== this._feishuConfig.appId || appSecret !== this._feishuConfig.appSecret) {
      this._feishuConfig = { appId, appSecret };
      // 落一份到 globalState 作首屏占位缓存（真相仍以 server 为准）
      this._memento?.update('feishuConfig', this._feishuConfig);
      changed = true;
    }
    if (enabled !== this._feishuEnabled) {
      this._feishuEnabled = enabled;
      changed = true;
    }
    if (ack !== this._feishuAck) {
      this._feishuAck = ack;
      changed = true;
    }
    if (queue !== this._feishuQueue) {
      this._feishuQueue = queue;
      changed = true;
    }
    if (bound !== this._feishuBound) {
      this._feishuBound = bound;
      changed = true;
    }
    if (changed) this._postFeishuState();
  }

  /** 把当前飞书配置 POST 给所有已连接的 server（server 端写同一份磁盘、全局一致；清空即下发空以关闭） */
  private _broadcastFeishuConfig() {
    const ports = new Set<number>(this._debugInfo.connectedPorts || []);
    if (this._activePort) ports.add(this._activePort);
    const { appId, appSecret } = this._feishuConfig;
    const body = JSON.stringify({
      appId,
      appSecret,
      enabled: this._feishuEnabled,
      ackReaction: this._feishuAck,
      queueWhenBusy: this._feishuQueue,
    });
    for (const port of ports) {
      this._httpPost(`http://127.0.0.1:${port}/api/feishu/config`, body).catch(() => {});
    }
  }

  // ---------- 扫码一键创建飞书应用 ----------
  private _registerPollTimer: NodeJS.Timeout | null = null;
  private _registerPort: number | null = null;

  private _postRegisterState(payload: Record<string, unknown>) {
    this._view?.webview.postMessage({ type: 'feishuRegisterState', payload });
  }

  /**
   * 发起扫码创建：找一个活跃的 MCP server（凭证写磁盘全局共享，任一进程均可），
   * 拿到验证链接后本地生成二维码 dataURL 推给面板，随后轮询直到成功/失败。
   */
  private async _handleFeishuRegisterStart() {
    this._stopRegisterPolling();
    const port = await this._findAnyServerPort();
    if (!port) {
      this._postRegisterState({ status: 'error', error: this._i18n.registerNoServer });
      return;
    }
    this._registerPort = port;
    try {
      // register/start 要等二维码就绪（服务端最多 10s）才响应，超时给足余量。
      // 二维码 dataURL 由 server 生成（插件 VSIX 不带 node_modules，装不进二维码库）
      const raw = await this._httpPost(`http://127.0.0.1:${port}/api/feishu/register/start`, '{}', 15000);
      const state = JSON.parse(raw) as { status: string; url?: string; qr?: string; expireIn?: number; error?: string };
      if (state.status === 'waiting' && state.url) {
        this._postRegisterState({ status: 'waiting', url: state.url, expireIn: state.expireIn, qr: state.qr });
        this._startRegisterPolling(port);
      } else {
        this._postRegisterState({ status: 'error', error: state.error || 'failed' });
      }
    } catch {
      this._postRegisterState({ status: 'error', error: this._i18n.registerNoServer });
    }
  }

  private _handleFeishuRegisterCancel() {
    this._stopRegisterPolling();
    if (this._registerPort) {
      this._httpPost(`http://127.0.0.1:${this._registerPort}/api/feishu/register/cancel`, '{}').catch(() => {});
      this._registerPort = null;
    }
  }

  private _startRegisterPolling(port: number) {
    this._stopRegisterPolling();
    this._registerPollTimer = setInterval(async () => {
      try {
        const raw = await this._httpGet(`http://127.0.0.1:${port}/api/feishu/register/status`);
        const st = JSON.parse(raw) as { status: string; appId?: string; error?: string };
        if (st.status === 'success') {
          this._stopRegisterPolling();
          this._postRegisterState({ status: 'success', appId: st.appId });
        } else if (st.status === 'error' || st.status === 'idle') {
          this._stopRegisterPolling();
          this._postRegisterState({ status: 'error', error: st.error || 'failed' });
        }
      } catch {
        // server 暂时不可达：下一轮再试
      }
    }, 2000);
  }

  private _stopRegisterPolling() {
    if (this._registerPollTimer) {
      clearInterval(this._registerPollTimer);
      this._registerPollTimer = null;
    }
  }

  /** 找任意一个可达的 MCP server 端口（优先当前活跃端口，避免全端口扫描） */
  private async _findAnyServerPort(): Promise<number | null> {
    const alive = async (port: number): Promise<boolean> => {
      try {
        const raw = await this._httpGet(`http://127.0.0.1:${port}/api/health`);
        return JSON.parse(raw).status === 'ok';
      } catch {
        return false;
      }
    };
    const preferred = [this._activePort, this._currentRequestPort, ...(this._debugInfo.connectedPorts || [])]
      .filter((p): p is number => typeof p === 'number');
    for (const p of preferred) {
      if (await alive(p)) return p;
    }
    const ports: number[] = [];
    for (let i = 0; i < this._portScanRange; i++) {
      const p = this._basePort + i;
      if (!preferred.includes(p)) ports.push(p);
    }
    const hits = await Promise.all(ports.map(async (p) => ((await alive(p)) ? p : null)));
    return hits.find((p): p is number => p !== null) ?? null;
  }

  /** 打开外部链接（webview 内点「打开链接」时用；仅放行 http/https） */
  private _handleOpenLink(url?: string) {
    if (!url || !/^https?:\/\//i.test(url)) return;
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /**
   * 切换飞书通知开关（关了即使已配置也不推飞书；长连接仍保留以便绑定/回复）
   */
  private async _handleToggleFeishuEnabled(enabled: boolean) {
    this._feishuEnabled = enabled;
    await this._memento?.update('feishuEnabled', enabled);
    this._broadcastFeishuConfig();
    this._postFeishuState();
  }

  /**
   * 切换系统通知开关（写入 VSCode 配置，_sendSystemNotification 会读取）
   */
  private async _handleToggleSystemNotification(enabled: boolean) {
    await vscode.workspace
      .getConfiguration('cursorFeedback')
      .update('systemNotification', enabled, vscode.ConfigurationTarget.Global);
    this._postFeishuState();
  }

  /**
   * 切换「失焦时系统提示」子开关（插件通知的子项，写入 VSCode 配置）
   */
  private async _handleToggleOsNotification(enabled: boolean) {
    await vscode.workspace
      .getConfiguration('cursorFeedback')
      .update('osNotification', enabled, vscode.ConfigurationTarget.Global);
    this._postFeishuState();
  }

  /**
   * 切换「Get 表情回执」子开关（飞书通知的子项；透传到 server 端 feishu bridge）
   */
  private async _handleToggleFeishuAck(enabled: boolean) {
    this._feishuAck = enabled;
    await this._memento?.update('feishuAck', enabled);
    this._broadcastFeishuConfig();
    this._postFeishuState();
  }

  /**
   * 切换「忙时消息排队」子开关（飞书通知的子项；透传到 server 端，控制忙时队列）
   */
  private async _handleToggleFeishuQueue(enabled: boolean) {
    this._feishuQueue = enabled;
    await this._memento?.update('feishuQueue', enabled);
    this._broadcastFeishuConfig();
    this._postFeishuState();
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
  private _httpPost(url: string, body: string, timeoutMs = 5000): Promise<string> {
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
        timeout: timeoutMs
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

  /**
   * 把 summary 里的本地图片路径内联成 base64 data:，
   * 这样 webview 无需 file:// 访问权限即可显示 AI 发来的本地图片。
   * 网络图（http/https）和已有的 data:/blob: 不处理，交给 CSP 放行。
   */
  private _inlineLocalImages(md: string): string {
    if (!md) return md;
    return md.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g, (full, alt, src, title) => {
      try {
        let p = String(src).trim().replace(/^["']|["']$/g, '');
        if (/^(https?:|data:|blob:)/i.test(p)) return full;
        if (p.startsWith('file://')) p = decodeURIComponent(p.replace(/^file:\/\//, ''));
        if (!path.isAbsolute(p) || !fs.existsSync(p)) return full;
        const mime = this._imageMime(p);
        if (!mime) return full;
        const b64 = fs.readFileSync(p).toString('base64');
        return `![${alt}](data:${mime};base64,${b64}${title || ''})`;
      } catch {
        return full;
      }
    });
  }

  private _imageMime(p: string): string | null {
    switch (path.extname(p).toLowerCase()) {
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.gif': return 'image/gif';
      case '.webp': return 'image/webp';
      case '.svg': return 'image/svg+xml';
      case '.bmp': return 'image/bmp';
      default: return null;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // 获取资源文件的 URI
    const markedJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'vendor', 'marked.min.js')
    );
    const highlightJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'vendor', 'highlight.min.js')
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

    // CSP 策略：放宽 img-src 以支持 AI 在 summary 里发来的网络图片 / vscode 资源 / base64
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https: data: blob:;`;

    // 获取语言设置
    const language = getLanguage();
    const langCode = language === 'zh-TW' ? 'zh-TW' : (language === 'en' ? 'en' : 'zh-CN');

    // 按平台解析快捷键占位符（mac vs win/linux），未知占位符保持原样
    const isMac = process.platform === 'darwin';
    const placeholders: Record<string, string> = {
      shortcut: isMac ? '⇧⌘\'' : 'Ctrl+Shift+\'',
      ctrlEnter: isMac ? '⌘Enter' : 'Ctrl+Enter',
      shiftEnter: isMac ? '⇧Enter' : 'Shift+Enter',
    };
    const i18nResolved: Record<string, string> = {};
    for (const k of Object.keys(this._i18n as Record<string, unknown>)) {
      const v = (this._i18n as Record<string, unknown>)[k];
      i18nResolved[k] = typeof v === 'string'
        ? v.replace(/\{(\w+)\}/g, (m, name) => placeholders[name] ?? m)
        : (v as string);
    }
    // 通知权限排查提示按平台注入（linux 的 notify-send 基本不会被拒，留空则前端整行隐藏）
    i18nResolved['notifyTroubleshoot'] = process.platform === 'darwin'
      ? this._i18n.notifyTroubleshootMac
      : process.platform === 'win32'
        ? this._i18n.notifyTroubleshootWin
        : '';

    // 替换占位符
    htmlTemplate = htmlTemplate
      .replace(/\{\{CSP\}\}/g, csp)
      .replace(/\{\{LANG\}\}/g, langCode)
      .replace(/\{\{MARKED_JS_URI\}\}/g, markedJsUri.toString())
      .replace(/\{\{HIGHLIGHT_JS_URI\}\}/g, highlightJsUri.toString())
      .replace(/\{\{STYLES_CSS_URI\}\}/g, stylesCssUri.toString())
      .replace(/\{\{SCRIPT_JS_URI\}\}/g, scriptJsUri.toString())
      .replace(/\{\{I18N_JSON\}\}/g, JSON.stringify(i18nResolved))
      .replace(/\{\{i18n\.(\w+)\}\}/g, (_, key) => {
        // 用 undefined 判断而非 ||：空字符串是合法值（如 linux 的 notifyTroubleshoot 留空以隐藏整行），
        // 用 || 会把 key 名渲染到界面上
        return i18nResolved[key] !== undefined ? i18nResolved[key] : key;
      });

    return htmlTemplate;
  }
}
