// WebView 脚本
(function () {
  const vscode = acquireVsCodeApi();
  const i18n = window.i18n || {};

  const previousState = vscode.getState();

  // ---------- SVG icon helpers ----------
  const ICONS = {
    remove: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
  };
  function svg(paths, cls) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', 'currentColor');
    el.setAttribute('stroke-width', '2');
    el.setAttribute('stroke-linecap', 'round');
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('aria-hidden', 'true');
    if (cls) el.setAttribute('class', cls);
    el.innerHTML = paths;
    return el;
  }

  // ---------- Markdown ----------
  function renderMarkdown(text) {
    if (!text) return '';
    try {
      if (typeof marked !== 'undefined') {
        marked.setOptions({ breaks: true, gfm: true, headerIds: false });
        return marked.parse(text);
      }
    } catch (e) {
      console.error('Markdown rendering error:', e);
    }
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  // 代码块语法高亮（highlight.js）：markdown 渲染后对 pre code 上色
  function highlightCodeBlocks(container) {
    if (typeof hljs === 'undefined' || !container) return;
    container.querySelectorAll('pre code').forEach((el) => {
      try { hljs.highlightElement(el); } catch (e) { /* ignore */ }
    });
  }

  // ---------- DOM ----------
  const serverStatus = document.getElementById('serverStatus');
  const serverStatusText = document.getElementById('serverStatusText');
  const debugTooltip = document.getElementById('debugTooltip');
  const langSwitchBtn = document.getElementById('langSwitchBtn');
  const waitingStatus = document.getElementById('waitingStatus');
  const feedbackForm = document.getElementById('feedbackForm');
  const summaryContent = document.getElementById('summaryContent');
  const projectInfo = document.getElementById('projectInfo');
  const feedbackInput = document.getElementById('feedbackInput');
  const submitBtn = document.getElementById('submitBtn');
  const submitLabel = document.getElementById('submitLabel');
  const submitKbd = document.getElementById('submitKbd');
  const uploadBtn = document.getElementById('uploadBtn');
  const selectPathBtn = document.getElementById('selectPathBtn');
  const insertContextBtn = document.getElementById('insertContextBtn');
  const mentionPopup = document.getElementById('mentionPopup');
  const imageInput = document.getElementById('imageInput');
  const imagePreview = document.getElementById('imagePreview');
  const refChips = document.getElementById('refChips');
  const charCount = document.getElementById('charCount');
  const timeoutWrap = document.getElementById('timeoutWrap');
  const timeoutBar = document.getElementById('timeoutBar');
  const timeoutInfo = document.getElementById('timeoutInfo');
  const pauseBtn = document.getElementById('pauseBtn');
  const quickReplies = document.getElementById('quickReplies');
  const toggleKeyModeBtn = document.getElementById('toggleKeyModeBtn');
  const dropOverlay = document.getElementById('dropOverlay');
  const summaryCard = document.getElementById('summaryCard');
  const splitter = document.getElementById('splitter');
  const autoRetryBtn = document.getElementById('autoRetryBtn');
  const themeAccentBtn = document.getElementById('themeAccentBtn');
  const submitBar = document.getElementById('submitBar');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const feishuBtn = document.getElementById('feishuBtn');
  const feishuModal = document.getElementById('feishuModal');
  const feishuCloseBtn = document.getElementById('feishuCloseBtn');
  const feishuAppIdInput = document.getElementById('feishuAppId');
  const feishuAppSecretInput = document.getElementById('feishuAppSecret');
  const feishuStatusEl = document.querySelector('.feishu-status');
  const feishuStatusText = document.getElementById('feishuStatusText');
  const feishuSecretToggle = document.getElementById('feishuSecretToggle');
  const feishuEnabledToggle = document.getElementById('feishuEnabledToggle');
  const systemNotifyToggle = document.getElementById('systemNotifyToggle');
  const osNotifyToggle = document.getElementById('osNotifyToggle');
  const feishuAckToggle = document.getElementById('feishuAckToggle');
  const queueWhenBusyToggle = document.getElementById('queueWhenBusyToggle');
  const osNotifySub = document.getElementById('osNotifySub');
  const feishuAckSub = document.getElementById('feishuAckSub');
  const notifyTestBtn = document.getElementById('notifyTestBtn');
  const notifyTestHint = document.getElementById('notifyTestHint');
  const historyBtn = document.getElementById('historyBtn');
  const historyPopup = document.getElementById('historyPopup');
  const toastEl = document.getElementById('toast');
  const queueCard = document.getElementById('queueCard');
  const queueList = document.getElementById('queueList');
  const queueCount = document.getElementById('queueCount');
  const waitingHintEl = waitingStatus.querySelector('.empty__hint');
  const defaultWaitingHint = waitingHintEl ? waitingHintEl.textContent : '';
  const summaryNav = document.getElementById('summaryNav');
  const summaryPrevBtn = document.getElementById('summaryPrevBtn');
  const summaryNextBtn = document.getElementById('summaryNextBtn');
  const summaryNavPos = document.getElementById('summaryNavPos');

  let uploadedImages = [];
  let attachedFiles = [];
  let codeRefs = [];
  let currentRequestId = '';
  let currentProjectDir = '';
  // 排队模式：AI 正忙（无等待中的反馈请求）时，同一个输入框用于「排队发送」，
  // 消息进服务端忙时队列，与飞书消息同队列按序送达
  let queueMode = false;
  let queueItems = [];
  // 忙时排队全局开关（真相在 server，随 feishuState 同步）：关了则等待态回到纯等待、不提供排队输入
  let queueEnabled = true;
  let requestTimestamp = 0;
  let requestTimeout = 300;
  let countdownInterval = null;
  let submitFallbackTimer = null;
  // 倒计时暂停态：真相源在 MCP server（HTTP 指令暂停/恢复真实计时器），
  // 这里只维护显示用的锚点，poll 每秒回传的 pauseState 会持续校准，不怕 webview 重建。
  let cdPaused = false;
  let cdRemainingMs = 0;
  let cdAnchor = 0;

  // ---------- Language switch ----------
  langSwitchBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchLanguage' });
  });

  // ---------- Timeout keep-waiting toggle ----------
  autoRetryBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'toggleAutoRetry' });
  });
  function updateAutoRetryUI(enabled) {
    autoRetryBtn.classList.toggle('is-on', enabled);
    autoRetryBtn.classList.toggle('is-off', !enabled);
    const tip = enabled
      ? (i18n.autoRetryOn || 'Timeout: keep waiting (click to end on timeout)')
      : (i18n.autoRetryOff || 'Timeout: end turn (click to keep waiting)');
    autoRetryBtn.setAttribute('data-tip', tip);
    autoRetryBtn.setAttribute('aria-label', tip);
  }
  updateAutoRetryUI(true);

  // ---------- Accent theme toggle (brand pink ⇄ follow IDE) ----------
  const ACCENT_KEY = 'cursorFeedback_accentMode';
  let accentMode = localStorage.getItem(ACCENT_KEY) === 'ide' ? 'ide' : 'brand';
  function applyAccentMode(mode) {
    accentMode = mode === 'ide' ? 'ide' : 'brand';
    document.body.classList.toggle('accent-ide', accentMode === 'ide');
    const isBrand = accentMode === 'brand';
    themeAccentBtn.classList.toggle('is-on', isBrand);
    themeAccentBtn.classList.toggle('is-off', !isBrand);
    const tip = isBrand
      ? (i18n.accentBrand || 'Accent: brand pink (click to follow IDE)')
      : (i18n.accentIde || 'Accent: follow IDE color (click for brand pink)');
    themeAccentBtn.setAttribute('data-tip', tip);
    themeAccentBtn.setAttribute('aria-label', tip);
  }
  themeAccentBtn.addEventListener('click', () => {
    applyAccentMode(accentMode === 'brand' ? 'ide' : 'brand');
    localStorage.setItem(ACCENT_KEY, accentMode);
  });
  applyAccentMode(accentMode);

  // ---------- Feishu notification settings ----------
  let feishuLastSavedSig = null;
  let feishuLastState = null;
  // 失焦即保存（已去掉「保存」按钮）：提交输入框当前值，与原保存按钮等价。
  // 同一 appId 下 secret 留空时后端会保留旧密钥，故自动保存安全；用 sig 去重避免无谓重存。
  function saveFeishuConfigFromInputs() {
    const appId = feishuAppIdInput.value.trim();
    const appSecret = feishuAppSecretInput.value.trim();
    const sig = appId + '\u0000' + appSecret;
    // 与上次提交值一致就不重复提交（基线为 null 时视为空，避免无谓提交）。
    if (sig === (feishuLastSavedSig ?? '\u0000')) return;
    feishuLastSavedSig = sig;
    vscode.postMessage({ type: 'saveFeishuConfig', payload: { appId, appSecret } });
  }
  feishuAppIdInput.addEventListener('blur', () => saveFeishuConfigFromInputs());
  feishuAppSecretInput.addEventListener('blur', () => saveFeishuConfigFromInputs());

  // 打开弹窗时读一次 server 当前凭证填入；之后后台轮询不再碰输入框（避免编辑时被覆盖/清空）。
  function fillFeishuInputs() {
    const s = feishuLastState;
    if (!s) return;
    if (typeof s.appId === 'string') feishuAppIdInput.value = s.appId;
    if (typeof s.appSecret === 'string') feishuAppSecretInput.value = s.appSecret;
    feishuLastSavedSig = feishuAppIdInput.value.trim() + '\u0000' + feishuAppSecretInput.value.trim();
  }
  function openFeishuModal() {
    fillFeishuInputs();
    feishuModal.classList.remove('hidden');
    feishuModal.setAttribute('aria-hidden', 'false');
    // 打开设置时向 server 查一次常驻服务状态（安装与否、版本）
    requestDaemonStatus();
    setTimeout(() => feishuAppIdInput.focus(), 0);
  }
  function closeFeishuModal() {
    // 兜底：Esc 关闭等场景输入框可能不触发 blur，关闭前再存一次（已去重，不会重复提交）
    saveFeishuConfigFromInputs();
    // 扫码创建流程进行中：关闭弹窗即取消（server 侧 abort，二维码作废）
    resetRegisterPanel(true);
    feishuModal.classList.add('hidden');
    feishuModal.setAttribute('aria-hidden', 'true');
  }
  feishuBtn.addEventListener('click', openFeishuModal);
  feishuCloseBtn.addEventListener('click', closeFeishuModal);
  feishuModal.addEventListener('click', (e) => {
    if (e.target === feishuModal) closeFeishuModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !feishuModal.classList.contains('hidden')) {
      e.stopPropagation();
      closeFeishuModal();
    }
  });

  // ---------- 常驻服务（IDE 关闭也可用）开关 ----------
  const daemonToggle = document.getElementById('daemonToggle');
  const daemonStatusText = document.getElementById('daemonStatusText');
  function requestDaemonStatus() {
    daemonToggle.disabled = true;
    vscode.postMessage({ type: 'requestDaemonStatus' });
  }
  daemonToggle.addEventListener('change', () => {
    // 安装/卸载是耗时操作（拷贝依赖 + 注册自启），期间锁住开关避免连点
    daemonToggle.disabled = true;
    daemonStatusText.textContent = i18n.daemonWorking || 'Working…';
    vscode.postMessage({ type: 'toggleDaemon', payload: { enabled: daemonToggle.checked } });
  });
  // ---------- 诊断包导出 ----------
  document.getElementById('diagExportBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'exportDiagnostics' });
  });

  function updateDaemonUI(s) {
    if (!s) return;
    daemonToggle.disabled = !s.supported;
    daemonToggle.checked = !!s.installed;
    let txt = '';
    if (!s.supported) {
      txt = i18n.daemonNotSupported || 'Not supported on this platform';
    } else if (s.error) {
      txt = (i18n.daemonFailed || 'Operation failed: {error}').replace('{error}', s.error);
    } else if (s.installed) {
      txt = (i18n.daemonInstalled || 'Installed v{version}').replace('{version}', s.installedVersion || '?');
    }
    daemonStatusText.textContent = txt;
  }

  // ---------- 扫码一键创建飞书应用 ----------
  // 点「扫码快速创建」→ extension 向 server 发起 Device Grant 流程 → 面板展示二维码 →
  // 用户在飞书确认 → 凭证自动写入 server 磁盘并生效，这里刷新输入框回显
  const feishuRegisterBtn = document.getElementById('feishuRegisterBtn');
  const feishuRegisterPanel = document.getElementById('feishuRegisterPanel');
  const feishuRegisterQr = document.getElementById('feishuRegisterQr');
  const feishuRegisterHint = document.getElementById('feishuRegisterHint');
  const feishuRegisterOpenBtn = document.getElementById('feishuRegisterOpenBtn');
  const feishuRegisterRetryBtn = document.getElementById('feishuRegisterRetryBtn');
  let registerActive = false;
  let registerUrl = '';

  function resetRegisterPanel(cancelServer) {
    if (cancelServer && registerActive) {
      vscode.postMessage({ type: 'feishuRegisterCancel' });
    }
    registerActive = false;
    registerUrl = '';
    feishuRegisterPanel.classList.add('hidden');
    feishuRegisterQr.classList.add('hidden');
    feishuRegisterOpenBtn.classList.add('hidden');
    feishuRegisterRetryBtn.classList.add('hidden');
    feishuRegisterHint.textContent = '';
  }

  function startRegister() {
    registerActive = true;
    feishuRegisterPanel.classList.remove('hidden');
    feishuRegisterQr.classList.add('hidden');
    feishuRegisterOpenBtn.classList.add('hidden');
    feishuRegisterRetryBtn.classList.add('hidden');
    feishuRegisterHint.textContent = i18n.registerLoading || 'Getting QR code…';
    vscode.postMessage({ type: 'feishuRegisterStart' });
  }

  feishuRegisterBtn.addEventListener('click', () => {
    if (registerActive) return;
    startRegister();
  });
  feishuRegisterRetryBtn.addEventListener('click', startRegister);
  feishuRegisterOpenBtn.addEventListener('click', () => {
    if (registerUrl) vscode.postMessage({ type: 'openLink', payload: { url: registerUrl } });
  });

  function handleRegisterState(p) {
    if (!registerActive || !p) return;
    if (p.status === 'waiting') {
      registerUrl = p.url || '';
      if (p.qr) {
        feishuRegisterQr.src = p.qr;
        feishuRegisterQr.classList.remove('hidden');
      }
      feishuRegisterOpenBtn.classList.toggle('hidden', !registerUrl);
      feishuRegisterHint.textContent = i18n.registerScanHint || 'Scan with Feishu to create the app';
    } else if (p.status === 'success') {
      registerActive = false;
      registerUrl = '';
      feishuRegisterQr.classList.add('hidden');
      feishuRegisterOpenBtn.classList.add('hidden');
      feishuRegisterHint.textContent = (i18n.registerSuccess || 'Created! Credentials configured') +
        (p.appId ? ' (' + p.appId + ')' : '');
      // 凭证已写入 server 磁盘，等常规轮询把新凭证同步到 feishuLastState 后刷新输入框回显
      setTimeout(() => { fillFeishuInputs(); }, 1600);
      setTimeout(() => { fillFeishuInputs(); }, 4000); // 兜底再刷一次（轮询同步可能略慢）
    } else {
      // error
      feishuRegisterQr.classList.add('hidden');
      feishuRegisterOpenBtn.classList.add('hidden');
      feishuRegisterRetryBtn.classList.remove('hidden');
      feishuRegisterHint.textContent = (i18n.registerFailed || 'Failed') + (p.error ? ': ' + p.error : '');
      registerActive = false;
      registerUrl = '';
    }
  }

  // 密钥显示/隐藏切换（小眼睛）
  feishuSecretToggle.addEventListener('click', () => {
    const show = feishuAppSecretInput.type === 'password';
    feishuAppSecretInput.type = show ? 'text' : 'password';
    feishuSecretToggle.classList.toggle('is-visible', show);
    const tip = show ? (i18n.hideSecret || 'Hide secret') : (i18n.showSecret || 'Show secret');
    feishuSecretToggle.setAttribute('aria-label', tip);
    feishuSecretToggle.setAttribute('data-tip', tip);
  });

  // 通知开关（主：飞书通知 / 插件通知；子：Get 表情回执 / 失焦系统提示）
  feishuEnabledToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleFeishuEnabled', payload: { enabled: feishuEnabledToggle.checked } });
    syncSubSwitchDisabled();
  });
  systemNotifyToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleSystemNotification', payload: { enabled: systemNotifyToggle.checked } });
    syncSubSwitchDisabled();
  });
  osNotifyToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleOsNotification', payload: { enabled: osNotifyToggle.checked } });
  });
  feishuAckToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleFeishuAck', payload: { enabled: feishuAckToggle.checked } });
  });
  // 忙时排队是全局开关（飞书 + 面板共用队列），不受飞书主开关约束
  queueWhenBusyToggle.addEventListener('change', () => {
    vscode.postMessage({ type: 'toggleFeishuQueue', payload: { enabled: queueWhenBusyToggle.checked } });
    queueEnabled = queueWhenBusyToggle.checked;
    if (queueMode) enterQueueMode(); // 立即按新开关刷新等待态形态
  });

  // 发送测试通知：一键验证系统通知链路通不通（权限被拒时收不到，配合上方排查提示定位）
  let notifyTestHintTimer = null;
  notifyTestBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'testNotification' });
    notifyTestHint.textContent = i18n.notifyTestSentHint || 'Sent — check your system notifications.';
    if (notifyTestHintTimer) clearTimeout(notifyTestHintTimer);
    notifyTestHintTimer = setTimeout(() => { notifyTestHint.textContent = ''; }, 8000);
  });

  // 子开关受主开关约束：主关时子置灰禁用
  function syncSubSwitchDisabled() {
    const osOn = systemNotifyToggle.checked;
    osNotifyToggle.disabled = !osOn;
    if (osNotifySub) osNotifySub.classList.toggle('is-disabled', !osOn);
    const feishuOn = feishuEnabledToggle.checked;
    feishuAckToggle.disabled = !feishuOn;
    if (feishuAckSub) feishuAckSub.classList.toggle('is-disabled', !feishuOn);
  }

  function updateFeishuUI(state) {
    if (!state) return;
    // 凭证输入框不在这里刷新：后台轮询只缓存最新值，由打开弹窗时 fillFeishuInputs() 填入一次，
    // 避免编辑过程中被后端回显覆盖/清空。绿点、开关等非输入框状态照常实时刷新。
    feishuLastState = state;
    if (typeof state.feishuEnabled === 'boolean') {
      feishuEnabledToggle.checked = state.feishuEnabled;
    }
    if (typeof state.systemNotification === 'boolean') {
      systemNotifyToggle.checked = state.systemNotification;
    }
    if (typeof state.osNotification === 'boolean') {
      osNotifyToggle.checked = state.osNotification;
    }
    if (typeof state.feishuAck === 'boolean') {
      feishuAckToggle.checked = state.feishuAck;
    }
    if (typeof state.feishuQueue === 'boolean') {
      queueWhenBusyToggle.checked = state.feishuQueue;
      if (state.feishuQueue !== queueEnabled) {
        queueEnabled = state.feishuQueue;
        if (queueMode) enterQueueMode(); // 开关在别的窗口/server 侧变化：同步刷新等待态形态
      }
    }
    syncSubSwitchDisabled();
    feishuStatusEl.classList.toggle('is-configured', !!state.configured && !state.bound);
    feishuStatusEl.classList.toggle('is-bound', !!state.bound);
    let txt = i18n.feishuStatusUnconfigured || 'Not configured';
    if (state.bound) txt = i18n.feishuStatusBound || 'Configured & bound';
    else if (state.configured) txt = i18n.feishuStatusConfigured || 'Configured';
    feishuStatusText.textContent = txt;
  }

  // ---------- Lightbox (image zoom) ----------
  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.remove('hidden');
  }
  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImg.src = '';
  }
  lightbox.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) closeLightbox();
  });

  // ---------- Key mode (Enter vs Ctrl+Enter) ----------
  let enterToSubmit = localStorage.getItem('cursorFeedback_enterToSubmit') === 'true';

  function updateKeyModeUI() {
    submitLabel.textContent = queueMode
      ? (i18n.queueSend || 'Queue Message')
      : (i18n.submitFeedback || 'Submit');
    if (enterToSubmit) {
      if (submitKbd) submitKbd.textContent = i18n.submitHintEnter || 'Enter';
      toggleKeyModeBtn.classList.add('enter-mode');
      toggleKeyModeBtn.title = i18n.switchToCtrlEnter || 'Click to switch to Ctrl+Enter submit';
    } else {
      if (submitKbd) submitKbd.textContent = i18n.submitHintCtrl || 'Ctrl+Enter';
      toggleKeyModeBtn.classList.remove('enter-mode');
      toggleKeyModeBtn.title = i18n.switchToEnter || 'Click to switch to Enter submit';
    }
  }
  updateKeyModeUI();

  toggleKeyModeBtn.addEventListener('click', () => {
    enterToSubmit = !enterToSubmit;
    localStorage.setItem('cursorFeedback_enterToSubmit', enterToSubmit.toString());
    updateKeyModeUI();
  });

  // ---------- IME composition ----------
  let isComposing = false;
  feedbackInput.addEventListener('compositionstart', () => { isComposing = true; });
  feedbackInput.addEventListener('compositionend', () => { isComposing = false; });

  // ---------- Draft persistence (text + images + files) ----------
  // 切换侧边栏/隐藏 webview 会销毁重建，靠 vscode state 把草稿（含图片、附件）整体存下来
  function saveDraft() {
    vscode.setState({
      text: feedbackInput.value,
      images: uploadedImages,
      files: attachedFiles,
      codeRefs: codeRefs
    });
  }

  function updateCharCount() {
    charCount.textContent = String(feedbackInput.value.length);
  }

  feedbackInput.addEventListener('input', () => {
    saveDraft();
    updateCharCount();
    checkMention();
  });

  // ---------- Attachments: pickers ----------
  uploadBtn.addEventListener('click', () => imageInput.click());
  selectPathBtn.addEventListener('click', () => vscode.postMessage({ type: 'selectPath' }));

  function makeRemoveBtn(onClick, extraClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip-remove' + (extraClass ? ' ' + extraClass : '');
    btn.setAttribute('aria-label', i18n.removeAttachment || 'Remove');
    btn.appendChild(svg(ICONS.remove));
    btn.addEventListener('click', onClick);
    return btn;
  }

  function isDirPath(p) {
    const last = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
    return p.endsWith('/') || p.endsWith('\\') || !last.includes('.');
  }

  function basename(p) {
    return (p || '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;
  }

  function makeRefChip(opts) {
    const chip = document.createElement('div');
    chip.className = 'ref-chip';
    chip.title = opts.title || opts.name;

    const ic = document.createElement('span');
    ic.className = 'ref-chip__icon';
    ic.appendChild(svg(opts.icon));
    chip.appendChild(ic);

    const nm = document.createElement('span');
    nm.className = 'ref-chip__name';
    nm.textContent = opts.name;
    chip.appendChild(nm);

    if (opts.meta) {
      const mt = document.createElement('span');
      mt.className = 'ref-chip__meta';
      mt.textContent = opts.meta;
      chip.appendChild(mt);
    }

    chip.appendChild(makeRemoveBtn(opts.onRemove));
    return chip;
  }

  // 统一渲染输入框上方的引用 chip：文件引用 + 代码引用（仿 Cursor）
  function renderRefChips() {
    refChips.innerHTML = '';
    attachedFiles.forEach((path) => {
      refChips.appendChild(makeRefChip({
        icon: isDirPath(path) ? ICONS.folder : ICONS.file,
        name: basename(path),
        title: path,
        onRemove: () => {
          const idx = attachedFiles.indexOf(path);
          if (idx > -1) attachedFiles.splice(idx, 1);
          renderRefChips();
          saveDraft();
        }
      }));
    });
    codeRefs.forEach((ref) => {
      const lines = ref.startLine === ref.endLine ? String(ref.startLine) : (ref.startLine + '-' + ref.endLine);
      refChips.appendChild(makeRefChip({
        icon: ICONS.code,
        name: ref.fileName,
        meta: ':' + lines,
        title: ref.fileName + ':' + lines,
        onRemove: () => {
          const idx = codeRefs.indexOf(ref);
          if (idx > -1) codeRefs.splice(idx, 1);
          renderRefChips();
          saveDraft();
        }
      }));
    });
  }

  function addAttachedFile(path) {
    if (attachedFiles.includes(path)) return;
    attachedFiles.push(path);
    renderRefChips();
    saveDraft();
  }

  // ---------- @ mention 文件选择器 ----------
  let allFilesCache = null;
  let allFilesCacheTime = 0;
  const FILES_CACHE_TTL = 30000; // 30s 后失效，让会话中新建的文件也能被 @ 到
  let mentionItems = [];
  let mentionIndex = 0;
  let mentionStart = -1;
  let mentionOpen = false;
  let pendingMentionQuery = null;
  let mentionDismissedAt = -1; // 被 Esc 主动取消的 @ 起点，避免同一个 @ 继续打字又弹出

  insertContextBtn.addEventListener('click', () => vscode.postMessage({ type: 'requestSelection' }));

  function checkMention() {
    const pos = feedbackInput.selectionStart;
    const before = feedbackInput.value.slice(0, pos);
    const m = before.match(/@([^\s@]*)$/);
    if (!m) { closeMention(); mentionDismissedAt = -1; return; }
    const start = pos - m[0].length;
    if (start === mentionDismissedAt) { return; } // 该 @ 已被 Esc 取消，继续打字不再自动弹
    mentionStart = start;
    const query = m[1];
    const cacheFresh = allFilesCache && (Date.now() - allFilesCacheTime < FILES_CACHE_TTL);
    if (!cacheFresh) {
      pendingMentionQuery = query;
      vscode.postMessage({ type: 'searchFiles' });
      return;
    }
    renderMention(query);
  }

  function renderMention(query) {
    const q = (query || '').toLowerCase();
    mentionItems = (allFilesCache || [])
      .filter(f => f.rel.toLowerCase().includes(q))
      .slice(0, 50);
    mentionIndex = 0;
    mentionPopup.innerHTML = '';
    if (mentionItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mention-empty';
      empty.textContent = i18n.noMatchFiles || 'No matching files';
      mentionPopup.appendChild(empty);
    } else {
      mentionItems.forEach((it, i) => {
        const el = document.createElement('div');
        el.className = 'mention-item' + (i === 0 ? ' active' : '');
        el.setAttribute('role', 'option');
        const icon = document.createElement('span');
        icon.className = 'mention-item__icon';
        icon.appendChild(svg(isDirPath(it.path) ? ICONS.folder : ICONS.file));
        const name = document.createElement('span');
        name.className = 'mention-item__name';
        name.textContent = it.name;
        const rel = document.createElement('span');
        rel.className = 'mention-item__path';
        rel.textContent = it.rel;
        el.appendChild(icon); el.appendChild(name); el.appendChild(rel);
        el.addEventListener('mousedown', (ev) => { ev.preventDefault(); selectMention(i); });
        mentionPopup.appendChild(el);
      });
    }
    positionMention();
    mentionPopup.classList.remove('hidden');
    mentionOpen = true;
  }

  function positionMention() {
    const r = feedbackInput.getBoundingClientRect();
    const spaceAbove = r.top;
    mentionPopup.style.left = r.left + 'px';
    mentionPopup.style.width = r.width + 'px';
    if (spaceAbove > 160) {
      mentionPopup.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      mentionPopup.style.top = 'auto';
      mentionPopup.style.maxHeight = Math.min(240, spaceAbove - 12) + 'px';
    } else {
      mentionPopup.style.top = (r.bottom + 4) + 'px';
      mentionPopup.style.bottom = 'auto';
      mentionPopup.style.maxHeight = Math.min(240, window.innerHeight - r.bottom - 12) + 'px';
    }
  }

  function moveMention(delta) {
    const items = mentionPopup.querySelectorAll('.mention-item');
    if (!items.length) return;
    const prev = items[mentionIndex];
    if (prev) prev.classList.remove('active');
    mentionIndex = (mentionIndex + delta + items.length) % items.length;
    const cur = items[mentionIndex];
    cur.classList.add('active');
    cur.scrollIntoView({ block: 'nearest' });
  }

  function selectMention(i) {
    const it = mentionItems[i];
    if (!it) { closeMention(); return; }
    addAttachedFile(it.path);
    const val = feedbackInput.value;
    const pos = feedbackInput.selectionStart;
    feedbackInput.value = val.slice(0, mentionStart) + val.slice(pos);
    feedbackInput.selectionStart = feedbackInput.selectionEnd = mentionStart;
    mentionDismissedAt = -1;
    closeMention();
    saveDraft();
    updateCharCount();
    feedbackInput.focus();
  }

  function closeMention() {
    mentionOpen = false;
    mentionPopup.classList.add('hidden');
    pendingMentionQuery = null;
  }

  document.addEventListener('click', (e) => {
    if (mentionOpen && !mentionPopup.contains(e.target) && e.target !== feedbackInput) {
      closeMention();
    }
  });

  // 压缩图片：限制最大边 + 转 JPEG，显著减小 base64 体积，节约 AI 上下文。
  // 注意：用 JPEG 而非 WebP —— 反馈图片要经过 MCP server 处理，而其图片链路未必注册 webp codec。
  function compressImage(dataUrl, fallbackName) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 1568;
          let w = img.naturalWidth || img.width;
          let h = img.naturalHeight || img.height;
          if (!w || !h) { resolve({ dataUrl: dataUrl, name: fallbackName }); return; }
          if (w > MAX || h > MAX) {
            const r = Math.min(MAX / w, MAX / h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          // 白底：避免透明 PNG 转 JPEG 后透明区域变黑
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const out = canvas.toDataURL('image/jpeg', 0.85);
          // 压缩反而更大时（少数小图），保留原图
          if (out.length >= dataUrl.length) { resolve({ dataUrl: dataUrl, name: fallbackName }); return; }
          const base = (fallbackName || ('image-' + Date.now())).replace(/\.\w+$/, '');
          resolve({ dataUrl: out, name: base + '.jpg' });
        } catch (e) {
          resolve({ dataUrl: dataUrl, name: fallbackName });
        }
      };
      img.onerror = () => resolve({ dataUrl: dataUrl, name: fallbackName });
      img.src = dataUrl;
    });
  }

  function renderImagePreview(imgData) {
    const item = document.createElement('div');
    item.className = 'preview';

    const img = document.createElement('img');
    img.src = imgData.dataUrl;
    img.alt = imgData.name;
    img.title = i18n.clickToZoom || 'Click to zoom';
    img.addEventListener('click', () => openLightbox(imgData.dataUrl));

    item.appendChild(img);
    item.appendChild(makeRemoveBtn(() => {
      const index = uploadedImages.indexOf(imgData);
      if (index > -1) uploadedImages.splice(index, 1);
      item.remove();
      saveDraft();
    }));
    imagePreview.appendChild(item);
  }

  function addImageFile(file) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const origName = file.name || ('pasted-image-' + Date.now() + '.png');
      const { dataUrl, name } = await compressImage(e.target.result, origName);
      const imgData = {
        name: name,
        dataUrl: dataUrl,
        size: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
      };
      uploadedImages.push(imgData);
      renderImagePreview(imgData);
      saveDraft();
    };
    reader.readAsDataURL(file);
  }

  imageInput.addEventListener('change', (e) => {
    for (const file of e.target.files) addImageFile(file);
    imageInput.value = '';
  });

  // ---------- Paste image ----------
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImageFile(file);
      }
    }
  });

  // ---------- Drag & drop images ----------
  let dragDepth = 0;
  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || feedbackForm.classList.contains('hidden')) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || feedbackForm.classList.contains('hidden')) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    dragDepth = 0;
    dropOverlay.classList.add('hidden');
    if (!e.dataTransfer || feedbackForm.classList.contains('hidden')) return;
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      if (file.type.startsWith('image/')) addImageFile(file);
    }
  });

  // ---------- Resizable summary / input panels ----------
  // 存「比例」而非绝对 px：webview 的 localStorage 多窗口共享，存绝对 px 会把大屏拖的高度
  // 串到小屏。改存占窗口高度的比例后，各屏按各自高度还原，比例一致、窗口缩放也跟着走。
  const SUMMARY_RATIO_KEY = 'cursorFeedback_summaryRatio';
  const DEFAULT_SUMMARY_RATIO = 0.42;

  // Upper bound keeps room for the input box + the pinned submit bar below.
  function splitMax() { return Math.max(120, window.innerHeight - 230); }

  function applySummaryHeight(px) {
    const h = Math.max(48, Math.min(px, splitMax()));
    summaryCard.style.height = h + 'px';
    return h;
  }

  function restoreSummaryHeight() {
    const saved = parseFloat(localStorage.getItem(SUMMARY_RATIO_KEY) || '');
    const ratio = saved > 0 && saved < 1 ? saved : DEFAULT_SUMMARY_RATIO;
    applySummaryHeight(Math.round(window.innerHeight * ratio));
  }
  restoreSummaryHeight();

  // 排队模式下分隔条调的是「顶部等待卡片」高度。与摘要卡共用同一比例（同一存储键、同一钳制），
  // 这样反馈态 ↔ 排队态切换时顶部区域高度完全一致，输入框不会上下跳动。
  function applyQueueTopHeight(px) {
    const h = Math.max(48, Math.min(px, splitMax()));
    waitingStatus.style.height = h + 'px';
    return h;
  }

  function clearQueueTopHeight() {
    waitingStatus.style.height = '';
  }

  function restoreQueueTopHeight() {
    const saved = parseFloat(localStorage.getItem(SUMMARY_RATIO_KEY) || '');
    const ratio = saved > 0 && saved < 1 ? saved : DEFAULT_SUMMARY_RATIO;
    applyQueueTopHeight(Math.round(window.innerHeight * ratio));
  }

  let splitDragging = false;
  let splitStartY = 0;
  let splitStartH = 0;

  splitter.addEventListener('mousedown', (e) => {
    splitDragging = true;
    splitStartY = e.clientY;
    splitStartH = (queueMode ? waitingStatus : summaryCard).getBoundingClientRect().height;
    splitter.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!splitDragging) return;
    const next = splitStartH + (e.clientY - splitStartY);
    if (queueMode) applyQueueTopHeight(next);
    else applySummaryHeight(next);
  });
  window.addEventListener('mouseup', () => {
    if (!splitDragging) return;
    splitDragging = false;
    splitter.classList.remove('is-dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    // 两种形态共用同一比例：任一形态下拖动都会同步到另一形态
    const el = queueMode ? waitingStatus : summaryCard;
    const ratio = el.getBoundingClientRect().height / window.innerHeight;
    localStorage.setItem(SUMMARY_RATIO_KEY, ratio.toFixed(4));
  });
  // 切换侧边栏 / 窗口缩放后用保存值恢复；不能读瞬时 getBoundingClientRect（隐藏态布局会把摘要异常压扁）
  window.addEventListener('resize', () => {
    restoreSummaryHeight();
    if (queueMode) restoreQueueTopHeight();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    restoreSummaryHeight();
    if (queueMode) restoreQueueTopHeight();
  });

  // ---------- Quick replies (一键发送的快捷短语，可编辑，存 localStorage) ----------
  const QUICK_REPLY_KEY = 'cursorFeedback_quickReplies';
  let quickReplyEditing = false;

  function defaultQuickReplies() {
    return [
      i18n.quickReplyDefault1 || 'Keep waiting for my feedback',
      i18n.quickReplyDefault2 || 'End the task'
    ];
  }

  function loadQuickReplies() {
    try {
      const raw = localStorage.getItem(QUICK_REPLY_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          return arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 20);
        }
      }
    } catch (e) { /* ignore */ }
    return defaultQuickReplies();
  }

  function saveQuickReplies(list) {
    try { localStorage.setItem(QUICK_REPLY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  // 点击快捷短语＝立即提交。已有草稿时把短语追加到末尾一起发，不悄悄丢弃用户已输入的内容
  // （排队模式下同样可用：短语走排队发送）
  function sendQuickReply(phrase) {
    if (submitBtn.disabled) return;
    if (!currentRequestId && !queueMode) return;
    const cur = feedbackInput.value.trim();
    feedbackInput.value = cur ? cur + '\n' + phrase : phrase;
    saveDraft();
    updateCharCount();
    submitFeedback();
  }

  // 编辑模式下把「添加输入框」里未回车的内容也收进列表（防止用户直接点完成而丢词）
  function commitQuickReplyDraft() {
    const inp = quickReplies.querySelector('.quick-add-input');
    const v = inp && inp.value.trim();
    if (!v) return;
    const next = loadQuickReplies();
    if (!next.includes(v)) {
      next.push(v);
      saveQuickReplies(next);
    }
  }

  function renderQuickReplies() {
    if (!quickReplies) return;
    const list = loadQuickReplies();
    quickReplies.innerHTML = '';

    list.forEach((phrase, idx) => {
      // 编辑态用 span：chip 内含删除按钮，button 嵌 button 不合法
      const chip = document.createElement(quickReplyEditing ? 'span' : 'button');
      if (!quickReplyEditing) chip.type = 'button';
      chip.className = 'quick-chip' + (quickReplyEditing ? ' is-editing' : '');
      chip.title = quickReplyEditing ? phrase : ((i18n.quickReplySendTip || 'Click to send') + ' · ' + phrase);

      const label = document.createElement('span');
      label.className = 'quick-chip__label';
      label.textContent = phrase;
      chip.appendChild(label);

      if (quickReplyEditing) {
        chip.appendChild(makeRemoveBtn(() => {
          const next = loadQuickReplies();
          next.splice(idx, 1);
          saveQuickReplies(next);
          renderQuickReplies();
        }));
      } else {
        chip.addEventListener('click', () => sendQuickReply(phrase));
      }
      quickReplies.appendChild(chip);
    });

    if (quickReplyEditing) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'quick-add-input';
      input.placeholder = i18n.quickReplyAddPlaceholder || 'Type a phrase and press Enter';
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          const next = loadQuickReplies();
          if (!next.includes(v)) {
            next.push(v);
            saveQuickReplies(next);
          }
          renderQuickReplies();
          const ni = quickReplies.querySelector('.quick-add-input');
          if (ni) ni.focus();
        } else if (e.key === 'Escape') {
          quickReplyEditing = false;
          renderQuickReplies();
        }
      });
      quickReplies.appendChild(input);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'iconbtn quick-edit-btn' + (quickReplyEditing ? ' is-on' : '');
    const tip = quickReplyEditing
      ? (i18n.quickReplyDone || 'Done editing')
      : (i18n.quickReplyEdit || 'Edit quick replies');
    editBtn.setAttribute('aria-label', tip);
    editBtn.setAttribute('data-tip', tip);
    editBtn.appendChild(svg(quickReplyEditing ? ICONS.check : ICONS.pencil));
    editBtn.addEventListener('click', () => {
      if (quickReplyEditing) commitQuickReplyDraft();
      quickReplyEditing = !quickReplyEditing;
      renderQuickReplies();
      if (quickReplyEditing) {
        const ni = quickReplies.querySelector('.quick-add-input');
        if (ni) ni.focus();
      }
    });
    quickReplies.appendChild(editBtn);
  }
  renderQuickReplies();

  // ---------- Tooltips（data-tip 全局浮层） ----------
  // 用单例 fixed 浮层代替 CSS ::after：绝对定位伪元素会被任何 overflow 祖先裁切
  //（工具条/卡片边缘的按钮 tooltip 曾被切掉半截）。fixed + 视口钳制彻底规避。
  const tipFloat = document.createElement('div');
  tipFloat.className = 'tip-float hidden';
  document.body.appendChild(tipFloat);

  function showTipFor(el) {
    const text = el.getAttribute('data-tip');
    if (!text) { hideTip(); return; }
    tipFloat.textContent = text;
    tipFloat.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    const tw = tipFloat.offsetWidth;
    const th = tipFloat.offsetHeight;
    // 默认在元素上方居中；顶部放不下则翻到下方；水平钳制在视口内
    let top = r.top - th - 6;
    if (top < 4) top = r.bottom + 6;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    tipFloat.style.top = top + 'px';
    tipFloat.style.left = left + 'px';
  }
  function hideTip() {
    tipFloat.classList.add('hidden');
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    const el = t && t.closest ? t.closest('[data-tip]') : null;
    if (el) showTipFor(el);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target;
    const el = t && t.closest ? t.closest('[data-tip]') : null;
    if (!el) return;
    if (e.relatedTarget && el.contains(e.relatedTarget)) return; // 仍在元素内部移动
    hideTip();
  });
  // 点击可能切换按钮语义（如超时续期开/关会改 data-tip），立即刷新提示文本
  document.addEventListener('click', (e) => {
    const t = e.target;
    const el = t && t.closest ? t.closest('[data-tip]') : null;
    if (el) showTipFor(el);
  });
  window.addEventListener('scroll', hideTip, true);

  // ---------- Toast (提交结果轻提示) ----------
  let toastTimer = null;
  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    // 重触发进入动画
    toastEl.classList.remove('is-in');
    void toastEl.offsetWidth;
    toastEl.classList.add('is-in');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('is-in');
      toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 300);
    }, 3500);
  }

  // ---------- Feedback history (最近提交的反馈，点击回填) ----------
  // 只存文本不存图片（图片 base64 太大会撑爆 localStorage）；上限 20 条
  const HISTORY_KEY = 'cursorFeedback_history';
  const HISTORY_MAX = 20;
  let historyOpen = false;
  // 提交发出时暂存文本，等 extension 确认成功（feedbackSubmitted）后才写入历史，
  // 避免提交失败的内容混进历史
  let pendingHistoryText = '';

  function loadHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      if (Array.isArray(arr)) {
        return arr.filter((e) => e && typeof e.text === 'string' && e.text.trim());
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function pushHistory(text) {
    const t = (text || '').trim();
    if (!t) return; // 纯图片/附件提交没有文本，不记
    let list = loadHistory();
    // 与最近一条相同（如快捷短语连点）就只刷新时间，不堆重复条目
    list = list.filter((e) => e.text !== t);
    list.unshift({ text: t, at: Date.now() });
    if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  function formatHistoryTime(at) {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? hm : (pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm);
  }

  function positionHistoryPopup() {
    const r = historyBtn.getBoundingClientRect();
    historyPopup.style.left = '8px';
    historyPopup.style.right = '8px';
    historyPopup.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    historyPopup.style.maxHeight = Math.min(280, r.top - 12) + 'px';
  }

  function renderHistoryPopup() {
    const list = loadHistory();
    historyPopup.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mention-empty';
      empty.textContent = i18n.historyEmpty || 'No history yet';
      historyPopup.appendChild(empty);
      return;
    }
    list.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.title = entry.text;

      const text = document.createElement('span');
      text.className = 'history-item__text';
      text.textContent = entry.text.replace(/\s+/g, ' ');
      item.appendChild(text);

      const time = document.createElement('span');
      time.className = 'history-item__time';
      time.textContent = formatHistoryTime(entry.at);
      item.appendChild(time);

      item.appendChild(makeRemoveBtn((ev) => {
        ev.stopPropagation();
        const next = loadHistory().filter((e) => !(e.text === entry.text && e.at === entry.at));
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
        renderHistoryPopup();
      }, 'history-item__remove'));

      // 点击回填：已有草稿则换行追加，不覆盖用户正在写的内容
      item.addEventListener('click', () => {
        const cur = feedbackInput.value;
        feedbackInput.value = cur.trim() ? cur.replace(/\n?$/, '\n') + entry.text : entry.text;
        saveDraft();
        updateCharCount();
        closeHistoryPopup();
        feedbackInput.focus();
      });
      historyPopup.appendChild(item);
    });
  }

  function openHistoryPopup() {
    renderHistoryPopup();
    positionHistoryPopup();
    historyPopup.classList.remove('hidden');
    historyOpen = true;
  }
  function closeHistoryPopup() {
    historyPopup.classList.add('hidden');
    historyOpen = false;
  }
  historyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (historyOpen) closeHistoryPopup();
    else openHistoryPopup();
  });
  document.addEventListener('click', (e) => {
    if (historyOpen && !historyPopup.contains(e.target)) closeHistoryPopup();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && historyOpen) closeHistoryPopup();
  });

  // ---------- Countdown + progress bar ----------
  function updatePauseUI() {
    timeoutWrap.classList.toggle('is-paused', cdPaused);
    const tip = cdPaused
      ? (i18n.resumeCountdown || 'Resume countdown')
      : (i18n.pauseCountdown || 'Pause countdown');
    pauseBtn.setAttribute('data-tip', tip);
    pauseBtn.setAttribute('aria-label', tip);
  }

  function currentRemainingMs() {
    return cdPaused ? cdRemainingMs : Math.max(0, cdRemainingMs - (Date.now() - cdAnchor));
  }

  function updateCountdown() {
    if (!requestTimeout) return;
    const totalMs = requestTimeout * 1000;
    const remainingMs = currentRemainingMs();
    const remaining = Math.max(0, Math.round(remainingMs / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const ratio = Math.max(0, Math.min(1, remainingMs / totalMs));

    timeoutBar.style.width = (ratio * 100) + '%';
    timeoutWrap.classList.toggle('is-warning', !cdPaused && ratio <= 0.25 && ratio > 0.1);
    timeoutWrap.classList.toggle('is-danger', !cdPaused && ratio <= 0.1);

    const label = cdPaused ? (i18n.pausedLabel || 'Paused') : (i18n.remainingTime || 'Remaining time');
    timeoutInfo.textContent = label + ' ' + minutes + ':' + seconds.toString().padStart(2, '0');

    if (!cdPaused && remainingMs <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      timeoutInfo.textContent = i18n.timeout || 'Timeout';
    }
  }

  // 暂停/恢复：发给插件 → HTTP 通知 MCP server 冻结/重排真实计时器；UI 待 server 确认后刷新
  pauseBtn.addEventListener('click', () => {
    if (!currentRequestId) return;
    vscode.postMessage({
      type: 'togglePause',
      payload: { requestId: currentRequestId, paused: !cdPaused }
    });
  });

  // ---------- Submit ----------
  function setSubmitting(on) {
    if (on) {
      submitBtn.classList.add('is-loading');
      submitBtn.disabled = true;
      submitLabel.textContent = i18n.submitting || 'Submitting…';
      if (submitKbd) submitKbd.style.display = 'none';
    } else {
      submitBtn.classList.remove('is-loading');
      submitBtn.disabled = false;
      if (submitKbd) submitKbd.style.display = '';
      updateKeyModeUI();
    }
  }

  function resetForm() {
    feedbackInput.value = '';
    uploadedImages = [];
    attachedFiles = [];
    codeRefs = [];
    imagePreview.innerHTML = '';
    refChips.innerHTML = '';
    currentRequestId = '';
    updateCharCount();
    vscode.setState({});
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  }

  // 提交时把代码引用 chip 拼成 markdown 代码块附到反馈文本末尾
  function buildFeedbackText() {
    let text = feedbackInput.value.trim();
    if (codeRefs.length) {
      const blocks = codeRefs.map((r) => {
        const lines = r.startLine === r.endLine ? String(r.startLine) : (r.startLine + '-' + r.endLine);
        return '`' + r.fileName + ':' + lines + '`:\n```' + (r.lang || '') + '\n' + r.code + '\n```';
      });
      text += (text ? '\n\n' : '') + blocks.join('\n\n');
    }
    return text;
  }

  function submitFeedback() {
    if (submitBtn.disabled) return;
    // 无等待中的请求：排队模式下改走「排队发送」，消息进服务端忙时队列
    if (!currentRequestId) {
      if (queueMode) queueSend();
      return;
    }

    setSubmitting(true);
    // 先暂存本次文本，等 extension 确认成功后写入历史（提交失败不入历史）
    pendingHistoryText = buildFeedbackText();
    vscode.postMessage({
      type: 'submitFeedback',
      payload: {
        requestId: currentRequestId,
        interactive_feedback: pendingHistoryText,
        images: uploadedImages.map(im => ({ name: im.name, data: im.dataUrl.split(',')[1], size: im.size })),
        attachedFiles: attachedFiles,
        project_directory: currentProjectDir
      }
    });

    // 兜底：若 8s 内未收到等待态（例如提交失败），恢复按钮以便重试
    if (submitFallbackTimer) clearTimeout(submitFallbackTimer);
    submitFallbackTimer = setTimeout(() => setSubmitting(false), 8000);
  }

  // 排队发送：AI 忙时把消息交给 extension 转发到归属本工作区的 server 入队
  function queueSend() {
    const text = buildFeedbackText();
    if (!text && uploadedImages.length === 0 && attachedFiles.length === 0) return;

    setSubmitting(true);
    pendingHistoryText = text;
    vscode.postMessage({
      type: 'queueMessage',
      payload: {
        interactive_feedback: text,
        images: uploadedImages.map(im => ({ name: im.name, data: im.dataUrl.split(',')[1], size: im.size })),
        attachedFiles: attachedFiles
      }
    });

    if (submitFallbackTimer) clearTimeout(submitFallbackTimer);
    submitFallbackTimer = setTimeout(() => setSubmitting(false), 8000);
  }

  // 排队成功后只清空输入内容，保持排队模式（用户可能还要继续追加）
  function clearComposer() {
    feedbackInput.value = '';
    uploadedImages = [];
    attachedFiles = [];
    codeRefs = [];
    imagePreview.innerHTML = '';
    refChips.innerHTML = '';
    saveDraft();
    updateCharCount();
  }

  submitBtn.addEventListener('click', submitFeedback);
  feedbackInput.addEventListener('keydown', (e) => {
    if (mentionOpen && !mentionPopup.classList.contains('hidden')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMention(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveMention(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); selectMention(mentionIndex); return; }
      if (e.key === 'Escape') { e.preventDefault(); mentionDismissedAt = mentionStart; closeMention(); return; }
    }
    if (isComposing || e.isComposing) return;
    if (e.key !== 'Enter') return;
    if (enterToSubmit) {
      if (!e.shiftKey) { e.preventDefault(); submitFeedback(); }
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); submitFeedback();
    }
  });

  // ---------- Summary history（历史摘要回看） ----------
  // 每轮 showFeedbackRequest 存一条（同文本去重：超时续期会带相同 summary 重复到来），
  // 上限 20 条；摘要卡头部的 ‹ › 在轮次间翻看，新请求到来自动跳回最新
  const SUMMARY_HISTORY_KEY = 'cursorFeedback_summaryHistory';
  const SUMMARY_HISTORY_MAX = 20;
  let summaryHistIdx = 0; // 0 = 最新（当前轮）

  function loadSummaryHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(SUMMARY_HISTORY_KEY) || '[]');
      if (Array.isArray(arr)) {
        return arr.filter((e) => e && typeof e.text === 'string' && e.text.trim());
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function pushSummaryHistory(text) {
    const t = (text || '').trim();
    if (!t) return;
    let list = loadSummaryHistory();
    if (list.length && list[0].text === t) {
      list[0].at = Date.now(); // 超时续期重发同一摘要：只刷新时间
    } else {
      list.unshift({ text: t, at: Date.now() });
      if (list.length > SUMMARY_HISTORY_MAX) list = list.slice(0, SUMMARY_HISTORY_MAX);
    }
    try { localStorage.setItem(SUMMARY_HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  function renderSummaryAt(idx) {
    const list = loadSummaryHistory();
    if (list.length === 0) return;
    summaryHistIdx = Math.max(0, Math.min(idx, list.length - 1));
    const entry = list[summaryHistIdx];
    summaryContent.innerHTML = renderMarkdown(entry.text);
    highlightCodeBlocks(summaryContent);
    summaryContent.scrollTop = 0;
    // 只有 1 条时隐藏导航；查看历史轮次时给内容区打标（样式淡化以示区分）
    if (summaryNav) {
      summaryNav.hidden = list.length <= 1;
      if (summaryNavPos) {
        summaryNavPos.textContent = (summaryHistIdx + 1) + '/' + list.length;
        summaryNavPos.title = formatHistoryTime(entry.at);
      }
      if (summaryNextBtn) summaryNextBtn.disabled = summaryHistIdx === 0;
      if (summaryPrevBtn) summaryPrevBtn.disabled = summaryHistIdx >= list.length - 1;
    }
    summaryContent.classList.toggle('summary--past', summaryHistIdx > 0);
  }

  if (summaryPrevBtn) summaryPrevBtn.addEventListener('click', () => renderSummaryAt(summaryHistIdx + 1));
  if (summaryNextBtn) summaryNextBtn.addEventListener('click', () => renderSummaryAt(summaryHistIdx - 1));

  // ---------- Queue mode（AI 忙时排队） ----------
  // 排队模式 = 等待态 + 可用的输入框：摘要卡隐藏，顶部保留紧凑的等待提示与队列列表，
  // 提交按钮变「排队发送」。反馈模式 = 原有的摘要 + 提交形态。
  function enterQueueMode() {
    queueMode = true;
    waitingStatus.classList.remove('hidden');
    summaryCard.classList.add('hidden');
    // 有输入框时保留分隔条，可拖动调整「等待区 : 输入区」比例；纯等待态无可调对象
    splitter.classList.toggle('hidden', !queueEnabled);
    // 占位隐藏（保持行高）：倒计时行若整行消失，提交栏高度变化会让输入框上下跳动
    timeoutWrap.hidden = false;
    timeoutWrap.classList.add('countdown--idle');
    // 忙时排队开关（全局）关闭：纯等待态，不提供排队输入
    document.body.classList.toggle('queue-mode', queueEnabled);
    if (queueEnabled) restoreQueueTopHeight();
    else clearQueueTopHeight();
    if (waitingHintEl) {
      waitingHintEl.textContent = queueEnabled ? (i18n.queueModeHint || defaultWaitingHint) : defaultWaitingHint;
    }
    feedbackForm.classList.toggle('hidden', !queueEnabled);
    submitBar.classList.toggle('hidden', !queueEnabled);
    renderQueueList();
    updateKeyModeUI();
  }

  function enterFeedbackMode() {
    queueMode = false;
    document.body.classList.remove('queue-mode');
    waitingStatus.classList.add('hidden');
    clearQueueTopHeight();
    if (waitingHintEl) waitingHintEl.textContent = defaultWaitingHint;
    feedbackForm.classList.remove('hidden');
    submitBar.classList.remove('hidden');
    summaryCard.classList.remove('hidden');
    splitter.classList.remove('hidden');
    queueCard.classList.add('hidden');
    updateKeyModeUI();
  }

  function renderQueueList() {
    if (!queueCard) return;
    const items = queueItems || [];
    if (!queueMode || items.length === 0) {
      queueCard.classList.add('hidden');
      return;
    }
    queueCard.classList.remove('hidden');
    if (queueCount) queueCount.textContent = String(items.length);
    queueList.innerHTML = '';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'queue-item';

      const src = document.createElement('span');
      src.className = 'queue-item__source' + (it.source === 'feishu' ? ' is-feishu' : '');
      src.textContent = it.source === 'feishu' ? (i18n.sourceFeishu || 'Feishu') : (i18n.sourcePanel || 'Panel');
      row.appendChild(src);

      const text = document.createElement('span');
      text.className = 'queue-item__text';
      text.textContent = (it.text || '').replace(/\s+/g, ' ').trim();
      text.title = it.text || '';
      row.appendChild(text);

      const metaBits = [];
      if (it.images) metaBits.push((i18n.queueMetaImages || 'img') + '×' + it.images);
      if (it.files) metaBits.push((i18n.queueMetaFiles || 'file') + '×' + it.files);
      if (metaBits.length) {
        const meta = document.createElement('span');
        meta.className = 'queue-item__meta';
        meta.textContent = metaBits.join(' ');
        row.appendChild(meta);
      }

      const time = document.createElement('span');
      time.className = 'queue-item__time';
      time.textContent = formatHistoryTime(it.at);
      row.appendChild(time);

      // 撤回：乐观移除本地列表（失败时下一秒轮询会把消息补回来），请求按队列项端口路由
      row.appendChild(makeRemoveBtn((ev) => {
        ev.stopPropagation();
        queueItems = queueItems.filter((x) => x.id !== it.id);
        renderQueueList();
        vscode.postMessage({ type: 'removeQueued', payload: { id: it.id, port: it.port } });
      }, 'queue-item__remove'));

      queueList.appendChild(row);
    });
  }

  // ---------- Messages from extension ----------
  window.addEventListener('message', event => {
    const message = event.data;

    switch (message.type) {
      case 'showFeedbackRequest':
        enterFeedbackMode();
        if (submitFallbackTimer) { clearTimeout(submitFallbackTimer); submitFallbackTimer = null; }
        setSubmitting(false);
        currentRequestId = message.payload.requestId;
        currentProjectDir = message.payload.projectDir;
        requestTimestamp = message.payload.timestamp;
        requestTimeout = message.payload.timeout;
        cdPaused = false;
        cdRemainingMs = Math.max(0, requestTimeout * 1000 - (Date.now() - requestTimestamp));
        cdAnchor = Date.now();
        updatePauseUI();
        // 存入历史并渲染最新一轮（含导航状态刷新）
        pushSummaryHistory(message.payload.summary);
        renderSummaryAt(0);
        projectInfo.textContent = message.payload.projectDir;
        projectInfo.title = message.payload.projectDir;
        updateCharCount();
        feedbackInput.focus();
        timeoutWrap.hidden = false;
        timeoutWrap.classList.remove('countdown--idle');
        if (countdownInterval) clearInterval(countdownInterval);
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
        requestAnimationFrame(restoreSummaryHeight);
        break;

      case 'showWaiting':
        if (submitFallbackTimer) { clearTimeout(submitFallbackTimer); submitFallbackTimer = null; }
        resetForm();
        setSubmitting(false);
        cdPaused = false;
        updatePauseUI();
        // 等待态 = 排队模式：输入框保持可用，消息排队等 AI 下一轮读取
        enterQueueMode();
        break;

      case 'serverStatus':
        if (message.payload.connected) {
          serverStatus.classList.add('connected');
          serverStatusText.textContent = i18n.mcpServerConnected || 'MCP Server connected';
        } else {
          serverStatus.classList.remove('connected');
          serverStatusText.textContent = i18n.mcpServerDisconnected || 'MCP Server disconnected';
        }
        break;

      case 'updateDebugInfo': {
        const d = message.payload;
        const L = {
          debug: i18n.debugInfo || 'Debug Info',
          port: i18n.scanPort || 'Scan port',
          ws: i18n.workspace || 'Workspace',
          cur: i18n.currentPort || 'Current port',
          conn: i18n.connected || 'Connected',
          none: i18n.none || 'None',
          status: i18n.status || 'Status'
        };
        debugTooltip.textContent =
          `${L.debug}\n${L.port}: ${d.portRange}\n${L.ws}: ${d.workspacePath}\n` +
          `${L.cur}: ${d.activePort || '-'}\n` +
          `${L.conn}: ${d.connectedPorts.length > 0 ? d.connectedPorts.join(', ') : L.none}\n` +
          `${L.status}: ${d.lastStatus}`;
        break;
      }

      case 'filesSelected':
        if (message.payload.paths) {
          for (const path of message.payload.paths) addAttachedFile(path);
        }
        break;

      case 'fileSearchResults':
        allFilesCache = message.payload.files || [];
        allFilesCacheTime = Date.now();
        if (mentionOpen || pendingMentionQuery != null) {
          const q = pendingMentionQuery != null ? pendingMentionQuery : '';
          pendingMentionQuery = null;
          renderMention(q);
        }
        break;

      case 'insertContext': {
        const p = message.payload;
        const fileName = (p.filePath || '').split(/[\\/]/).pop();
        codeRefs.push({
          fileName: fileName,
          filePath: p.filePath,
          lang: p.lang || '',
          code: p.code,
          startLine: p.startLine,
          endLine: p.endLine
        });
        renderRefChips();
        saveDraft();
        feedbackInput.focus();
        break;
      }

      case 'insertContextEmpty':
        break;

      case 'autoRetryState':
        updateAutoRetryUI(!!message.payload.enabled);
        break;

      case 'pauseState': {
        // server 是暂停态与剩余时间的真相源：按钮确认与每秒 poll 都走这里持续校准，
        // webview 重建后也能恢复正确的暂停显示
        const p = message.payload || {};
        if (!currentRequestId || p.requestId !== currentRequestId) break;
        cdPaused = !!p.paused;
        if (typeof p.remainingMs === 'number') {
          cdRemainingMs = Math.max(0, p.remainingMs);
          cdAnchor = Date.now();
        }
        updatePauseUI();
        if (!countdownInterval && (cdPaused || cdRemainingMs > 0)) {
          countdownInterval = setInterval(updateCountdown, 1000);
        }
        updateCountdown();
        break;
      }

      case 'feishuState':
        updateFeishuUI(message.payload);
        break;

      case 'daemonState':
        updateDaemonUI(message.payload);
        break;

      case 'feishuRegisterState':
        handleRegisterState(message.payload);
        break;

      case 'feedbackSubmitted':
        // 提交已被 server 确认：写入历史 + 轻提示（queued = 撞上超时空窗、暂存待下一轮送达）
        pushHistory(pendingHistoryText);
        pendingHistoryText = '';
        showToast(message.payload && message.payload.queued
          ? (i18n.toastQueued || 'Queued — will be delivered to AI next round')
          : (i18n.toastSubmitted || 'Feedback sent'));
        break;

      case 'queueSubmitted': {
        // 排队发送的结果回执：成功则清空输入并入历史；失败明确提示原因，内容保留可重试
        if (submitFallbackTimer) { clearTimeout(submitFallbackTimer); submitFallbackTimer = null; }
        setSubmitting(false);
        const p = message.payload || {};
        if (p.success) {
          pushHistory(pendingHistoryText);
          pendingHistoryText = '';
          clearComposer();
          showToast(i18n.toastPanelQueued || '✓ Queued — delivered when the AI finishes this task');
        } else {
          showToast(p.reason === 'pending'
            ? (i18n.queueFailedPending || 'AI is waiting for your feedback — submit it directly instead')
            : p.reason === 'disabled'
              ? (i18n.queueFailedDisabled || 'Busy-time queuing is turned off in settings')
              : (i18n.queueFailedNoServer || 'No active AI session found — the message was not queued'));
        }
        break;
      }

      case 'queueState':
        // server 每秒随轮询下发的队列快照（extension 已做签名去重）
        queueItems = (message.payload && message.payload.items) || [];
        renderQueueList();
        break;

      case 'toast':
        // extension 侧的通用轻提示（如暂停失败：请求已结束）
        if (message.payload && message.payload.text) showToast(message.payload.text);
        break;
    }
  });

  // ---------- Init ----------
  (function restoreDraft() {
    const st = previousState;
    if (!st) return;
    if (st.text) feedbackInput.value = st.text;
    if (Array.isArray(st.images)) {
      for (const im of st.images) {
        if (im && im.dataUrl) { uploadedImages.push(im); renderImagePreview(im); }
      }
    }
    if (Array.isArray(st.files)) {
      for (const p of st.files) {
        if (p && !attachedFiles.includes(p)) attachedFiles.push(p);
      }
    }
    if (Array.isArray(st.codeRefs)) {
      for (const r of st.codeRefs) { if (r) codeRefs.push(r); }
    }
    renderRefChips();
  })();

  // 把快捷键用 kbd 框起来，让 ⇧⌘' 里那个 ' 更醒目
  (function renderContextHint() {
    const hint = document.querySelector('.composer__hint');
    if (!hint) return;
    const mention = i18n.contextHintMention || '@ files';
    const insert = i18n.contextHintInsert || '';
    hint.textContent = '';
    hint.appendChild(document.createTextNode(mention + ' · '));
    const kbd = document.createElement('kbd');
    kbd.className = 'hint-kbd';
    kbd.textContent = i18n.insertShortcut || '';
    hint.appendChild(kbd);
    hint.appendChild(document.createTextNode(' ' + insert));
  })();

  updateCharCount();
  // 默认进入排队模式（无等待中的请求时输入框即可用）；若有请求，
  // extension 在收到 ready 后会推 showFeedbackRequest 切回反馈模式
  enterQueueMode();
  setInterval(() => vscode.postMessage({ type: 'checkServer' }), 5000);
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'checkServer' });
})();
