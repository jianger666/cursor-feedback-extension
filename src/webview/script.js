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
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'
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
  const feishuGuideBtn = document.getElementById('feishuGuideBtn');
  const feishuSecretToggle = document.getElementById('feishuSecretToggle');
  const feishuEnabledToggle = document.getElementById('feishuEnabledToggle');
  const systemNotifyToggle = document.getElementById('systemNotifyToggle');
  const osNotifyToggle = document.getElementById('osNotifyToggle');
  const feishuAckToggle = document.getElementById('feishuAckToggle');
  const osNotifySub = document.getElementById('osNotifySub');
  const feishuAckSub = document.getElementById('feishuAckSub');

  let uploadedImages = [];
  let attachedFiles = [];
  let codeRefs = [];
  let currentRequestId = '';
  let currentProjectDir = '';
  let requestTimestamp = 0;
  let requestTimeout = 300;
  let countdownInterval = null;
  let submitFallbackTimer = null;

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
    setTimeout(() => feishuAppIdInput.focus(), 0);
  }
  function closeFeishuModal() {
    // 兜底：Esc 关闭等场景输入框可能不触发 blur，关闭前再存一次（已去重，不会重复提交）
    saveFeishuConfigFromInputs();
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
  feishuGuideBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openFeishuGuide' });
  });

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
    submitLabel.textContent = i18n.submitFeedback || 'Submit';
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

  let splitDragging = false;
  let splitStartY = 0;
  let splitStartH = 0;

  splitter.addEventListener('mousedown', (e) => {
    splitDragging = true;
    splitStartY = e.clientY;
    splitStartH = summaryCard.getBoundingClientRect().height;
    splitter.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!splitDragging) return;
    applySummaryHeight(splitStartH + (e.clientY - splitStartY));
  });
  window.addEventListener('mouseup', () => {
    if (!splitDragging) return;
    splitDragging = false;
    splitter.classList.remove('is-dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const ratio = summaryCard.getBoundingClientRect().height / window.innerHeight;
    localStorage.setItem(SUMMARY_RATIO_KEY, ratio.toFixed(4));
  });
  // 切换侧边栏 / 窗口缩放后用保存值恢复；不能读瞬时 getBoundingClientRect（隐藏态布局会把摘要异常压扁）
  window.addEventListener('resize', restoreSummaryHeight);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) restoreSummaryHeight();
  });

  // ---------- Countdown + progress bar ----------
  function updateCountdown() {
    if (!requestTimestamp || !requestTimeout) return;
    const elapsed = Math.floor((Date.now() - requestTimestamp) / 1000);
    const remaining = Math.max(0, requestTimeout - elapsed);
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const ratio = Math.max(0, Math.min(1, remaining / requestTimeout));

    timeoutBar.style.width = (ratio * 100) + '%';
    timeoutWrap.classList.toggle('is-warning', ratio <= 0.25 && ratio > 0.1);
    timeoutWrap.classList.toggle('is-danger', ratio <= 0.1);

    const label = i18n.remainingTime || 'Remaining time';
    timeoutInfo.textContent = label + ' ' + minutes + ':' + seconds.toString().padStart(2, '0');

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      timeoutInfo.textContent = i18n.timeout || 'Timeout';
    }
  }

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
    if (!currentRequestId || submitBtn.disabled) return;

    setSubmitting(true);
    vscode.postMessage({
      type: 'submitFeedback',
      payload: {
        requestId: currentRequestId,
        interactive_feedback: buildFeedbackText(),
        images: uploadedImages.map(im => ({ name: im.name, data: im.dataUrl.split(',')[1], size: im.size })),
        attachedFiles: attachedFiles,
        project_directory: currentProjectDir
      }
    });

    // 兜底：若 8s 内未收到等待态（例如提交失败），恢复按钮以便重试
    if (submitFallbackTimer) clearTimeout(submitFallbackTimer);
    submitFallbackTimer = setTimeout(() => setSubmitting(false), 8000);
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

  // ---------- Messages from extension ----------
  window.addEventListener('message', event => {
    const message = event.data;

    switch (message.type) {
      case 'showFeedbackRequest':
        waitingStatus.classList.add('hidden');
        feedbackForm.classList.remove('hidden');
        submitBar.classList.remove('hidden');
        if (submitFallbackTimer) { clearTimeout(submitFallbackTimer); submitFallbackTimer = null; }
        setSubmitting(false);
        currentRequestId = message.payload.requestId;
        currentProjectDir = message.payload.projectDir;
        requestTimestamp = message.payload.timestamp;
        requestTimeout = message.payload.timeout;
        summaryContent.innerHTML = renderMarkdown(message.payload.summary);
        highlightCodeBlocks(summaryContent);
        summaryContent.scrollTop = 0;
        projectInfo.textContent = message.payload.projectDir;
        projectInfo.title = message.payload.projectDir;
        updateCharCount();
        feedbackInput.focus();
        timeoutWrap.hidden = false;
        if (countdownInterval) clearInterval(countdownInterval);
        updateCountdown();
        countdownInterval = setInterval(updateCountdown, 1000);
        requestAnimationFrame(restoreSummaryHeight);
        break;

      case 'showWaiting':
        if (submitFallbackTimer) { clearTimeout(submitFallbackTimer); submitFallbackTimer = null; }
        resetForm();
        setSubmitting(false);
        feedbackForm.classList.add('hidden');
        submitBar.classList.add('hidden');
        waitingStatus.classList.remove('hidden');
        timeoutWrap.hidden = true;
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

      case 'feishuState':
        updateFeishuUI(message.payload);
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
  setInterval(() => vscode.postMessage({ type: 'checkServer' }), 5000);
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'checkServer' });
})();
