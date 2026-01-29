// WebView 脚本
(function() {
  const vscode = acquireVsCodeApi();
  const i18n = window.i18n || {};

  // 恢复之前保存的文本
  const previousState = vscode.getState();

  // Markdown 渲染
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

  // DOM 元素
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
  const uploadBtn = document.getElementById('uploadBtn');
  const selectPathBtn = document.getElementById('selectPathBtn');
  const imageInput = document.getElementById('imageInput');
  const imagePreview = document.getElementById('imagePreview');
  const fileList = document.getElementById('fileList');
  const timeoutInfo = document.getElementById('timeoutInfo');
  const toggleKeyModeBtn = document.getElementById('toggleKeyModeBtn');

  // 语言切换按钮
  langSwitchBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'switchLanguage' });
  });

  let uploadedImages = [];
  let attachedFiles = [];
  let currentRequestId = '';
  let currentProjectDir = '';
  let requestTimestamp = 0;
  let requestTimeout = 300;
  let countdownInterval = null;

  // 快捷键模式：false = Ctrl+Enter 提交（默认），true = Enter 提交
  let enterToSubmit = localStorage.getItem('cursorFeedback_enterToSubmit') === 'true';

  // 更新快捷键模式 UI
  function updateKeyModeUI() {
    if (enterToSubmit) {
      submitBtn.textContent = i18n.enterSubmitMode || 'Enter to submit · Shift+Enter for newline';
      toggleKeyModeBtn.classList.add('enter-mode');
      toggleKeyModeBtn.title = i18n.switchToCtrlEnter || 'Click to switch to Ctrl+Enter submit';
    } else {
      submitBtn.textContent = i18n.ctrlEnterSubmitMode || 'Ctrl+Enter to submit · Enter for newline';
      toggleKeyModeBtn.classList.remove('enter-mode');
      toggleKeyModeBtn.title = i18n.switchToEnter || 'Click to switch to Enter submit';
    }
  }

  // 初始化快捷键模式 UI
  updateKeyModeUI();

  // 切换快捷键模式
  toggleKeyModeBtn.addEventListener('click', () => {
    enterToSubmit = !enterToSubmit;
    localStorage.setItem('cursorFeedback_enterToSubmit', enterToSubmit.toString());
    updateKeyModeUI();
  });

  // 输入法组合状态（用于中文等输入法兼容）
  let isComposing = false;
  feedbackInput.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  feedbackInput.addEventListener('compositionend', () => {
    isComposing = false;
  });

  // 恢复输入框文本
  if (previousState?.text) {
    feedbackInput.value = previousState.text;
  }

  // 输入时保存文本
  feedbackInput.addEventListener('input', () => {
    vscode.setState({ text: feedbackInput.value });
  });

  // 图片上传
  uploadBtn.addEventListener('click', () => imageInput.click());
  selectPathBtn.addEventListener('click', () => vscode.postMessage({ type: 'selectPath' }));

  // 添加已选文件到列表
  function addAttachedFile(path) {
    if (attachedFiles.includes(path)) return;
    attachedFiles.push(path);
    
    const item = document.createElement('div');
    item.className = 'file-item';
    
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = (path.endsWith('/') || !path.split('/').pop().includes('.')) ? '📁' : '📄';
    
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
    for (const file of e.target.files) addImageFile(file);
  });

  // 添加图片到预览
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
      
      const container = document.createElement('div');
      container.className = 'image-preview-item';
      
      const img = document.createElement('img');
      img.src = base64;
      
      const removeBtn = document.createElement('button');
      removeBtn.className = 'image-remove';
      removeBtn.textContent = '×';
      removeBtn.onclick = () => {
        const index = uploadedImages.indexOf(imgData);
        if (index > -1) uploadedImages.splice(index, 1);
        container.remove();
      };
      
      container.appendChild(img);
      container.appendChild(removeBtn);
      imagePreview.appendChild(container);
    };
    reader.readAsDataURL(file);
  }

  // 粘贴图片支持
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) addImageFile(file);
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
    const remainingLabel = i18n.remainingTime || 'Remaining time';
    timeoutInfo.textContent = remainingLabel + ': ' + minutes + ':' + seconds.toString().padStart(2, '0');
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      timeoutInfo.textContent = i18n.timeout || 'Timeout';
    }
  }

  // 提交反馈
  function submitFeedback() {
    if (!currentRequestId) return;
    
    vscode.postMessage({
      type: 'submitFeedback',
      payload: {
        requestId: currentRequestId,
        interactive_feedback: feedbackInput.value.trim(),
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
    vscode.setState({}); // 清除保存的文本
    
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
  }

  submitBtn.addEventListener('click', submitFeedback);
  feedbackInput.addEventListener('keydown', (e) => {
    // 如果正在使用输入法（如中文输入），不触发提交
    if (isComposing || e.isComposing) return;

    if (e.key === 'Enter') {
      if (enterToSubmit) {
        // Enter 提交模式：Enter 提交，Shift+Enter 换行
        if (!e.shiftKey) {
          e.preventDefault();
          submitFeedback();
        }
      } else {
        // Ctrl+Enter 提交模式：Ctrl+Enter 提交，Enter 换行
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          submitFeedback();
        }
      }
    }
  });

  // 接收消息
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
        summaryContent.scrollTop = 0;
        projectInfo.textContent = '📁 ' + message.payload.projectDir;
        feedbackInput.focus();
        if (countdownInterval) clearInterval(countdownInterval);
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
          serverStatusText.textContent = i18n.mcpServerConnected || 'MCP Server connected';
        } else {
          serverStatus.classList.remove('connected');
          serverStatusText.textContent = i18n.mcpServerDisconnected || 'MCP Server disconnected';
        }
        break;
      
      case 'updateDebugInfo':
        const d = message.payload;
        const debugLabel = i18n.debugInfo || 'Debug Info';
        const scanPortLabel = i18n.scanPort || 'Scan port';
        const workspaceLabel = i18n.workspace || 'Workspace';
        const currentPortLabel = i18n.currentPort || 'Current port';
        const connectedLabel = i18n.connected || 'Connected';
        const noneLabel = i18n.none || 'None';
        const statusLabel = i18n.status || 'Status';
        debugTooltip.textContent = `🔍 ${debugLabel}\n━━━━━━━━━━━━\n${scanPortLabel}: ${d.portRange}\n${workspaceLabel}: ${d.workspacePath}\n${currentPortLabel}: ${d.activePort || '-'}\n${connectedLabel}: ${d.connectedPorts.length > 0 ? d.connectedPorts.join(', ') : noneLabel}\n${statusLabel}: ${d.lastStatus}`;
        break;
        
      case 'filesSelected':
        if (message.payload.paths) {
          for (const path of message.payload.paths) addAttachedFile(path);
        }
        break;
    }
  });

  // 定期检查服务器状态
  setInterval(() => vscode.postMessage({ type: 'checkServer' }), 5000);
  vscode.postMessage({ type: 'ready' });
  vscode.postMessage({ type: 'checkServer' });
})();
