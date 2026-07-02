import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type I18nMessages = {
  checkingConnection: string;
  waitingForAI: string;
  waitingHint: string;
  aiSummary: string;
  yourFeedback: string;
  feedbackPlaceholder: string;
  uploadImage: string;
  selectFilesOrFolders: string;
  submitFeedback: string;
  toggleKeyMode: string;
  remainingTime: string;
  timeout: string;
  enterSubmitMode: string;
  ctrlEnterSubmitMode: string;
  switchToCtrlEnter: string;
  switchToEnter: string;
  mcpServerConnected: string;
  mcpServerDisconnected: string;
  debugInfo: string;
  scanPort: string;
  workspace: string;
  currentPort: string;
  connected: string;
  none: string;
  status: string;
  aiWaitingFeedback: string;
  submitFailed: string;
  cannotConnectMCP: string;
  select: string;
  dropToUpload: string;
  submitting: string;
  removeAttachment: string;
  autoRetryOn: string;
  autoRetryOff: string;
  accentBrand: string;
  accentIde: string;
  clickToZoom: string;
  insertSelection: string;
  contextHint: string;
  contextHintMention: string;
  contextHintInsert: string;
  insertShortcut: string;
  mentionFiles: string;
  noMatchFiles: string;
  contextRefLabel: string;
  submitHintCtrl: string;
  submitHintEnter: string;
  statusNoWorkspace: string;
  statusListening: string;
  statusFound: string;
  statusNoServer: string;
  statusConnected: string;
  statusPollError: string;
  feishuSettings: string;
  feishuDesc: string;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuAppIdPlaceholder: string;
  feishuSecretPlaceholder: string;
  feishuGuide: string;
  feishuClose: string;
  feishuStatusUnconfigured: string;
  feishuStatusConfigured: string;
  feishuStatusBound: string;
  feishuHint: string;
  systemNotifyLabel: string;
  showSecret: string;
  hideSecret: string;
  notifySettingsTitle: string;
  pluginNotifyDesc: string;
  osNotifyLabel: string;
  osNotifyDesc: string;
  feishuAckLabel: string;
  feishuAckDesc: string;
  quickReplyDefault1: string;
  quickReplyDefault2: string;
  quickReplyEdit: string;
  quickReplyDone: string;
  quickReplyAddPlaceholder: string;
  quickReplySendTip: string;
  pauseCountdown: string;
  resumeCountdown: string;
  pausedLabel: string;
  notifyTroubleshootMac: string;
  notifyTroubleshootWin: string;
  notifyTestBtn: string;
  notifyTestSentHint: string;
  notifyTestBody: string;
  toastSubmitted: string;
  toastQueued: string;
  historyBtn: string;
  historyEmpty: string;
};

let cachedMessages: I18nMessages | null = null;
let cachedLanguage: string | null = null;

/**
 * 获取当前配置的语言
 */
export function getLanguage(): string {
  const config = vscode.workspace.getConfiguration('cursorFeedback');
  const configuredLang = config.get<string>('language') || 'auto';
  
  if (configuredLang === 'auto') {
    // 根据系统语言自动检测
    const vscodeLang = vscode.env.language; // 例如 'zh-cn', 'en', 'zh-tw'
    if (vscodeLang.startsWith('zh')) {
      return 'zh-CN';
    }
    return 'en';
  }
  
  return configuredLang;
}

/**
 * 加载语言消息
 */
export function loadMessages(extensionPath: string, language?: string): I18nMessages {
  const lang = language || getLanguage();
  
  // 如果语言没变，返回缓存
  if (cachedMessages && cachedLanguage === lang) {
    return cachedMessages;
  }
  
  // 尝试加载指定语言
  const langFile = path.join(extensionPath, 'dist', 'i18n', `${lang}.json`);
  const defaultFile = path.join(extensionPath, 'dist', 'i18n', 'zh-CN.json');
  
  try {
    if (fs.existsSync(langFile)) {
      cachedMessages = JSON.parse(fs.readFileSync(langFile, 'utf-8'));
    } else {
      // 回退到默认语言
      cachedMessages = JSON.parse(fs.readFileSync(defaultFile, 'utf-8'));
    }
    cachedLanguage = lang;
    return cachedMessages!;
  } catch (error) {
    console.error('Failed to load i18n messages:', error);
    // 返回硬编码的默认值
    return getDefaultMessages();
  }
}

/**
 * 默认消息（兜底）
 */
function getDefaultMessages(): I18nMessages {
  return {
    checkingConnection: "Checking connection...",
    waitingForAI: "Waiting for AI feedback request...",
    waitingHint: "The input interface will appear here when AI needs your feedback",
    aiSummary: "AI Summary",
    yourFeedback: "Your Feedback",
    feedbackPlaceholder: "Enter your feedback...",
    uploadImage: "Upload image",
    selectFilesOrFolders: "Select files/folders",
    submitFeedback: "Submit Feedback",
    toggleKeyMode: "Toggle key mode",
    remainingTime: "Remaining time",
    timeout: "Timeout",
    enterSubmitMode: "Enter to submit · Shift+Enter for newline",
    ctrlEnterSubmitMode: "Ctrl+Enter to submit · Enter for newline",
    switchToCtrlEnter: "Click to switch to Ctrl+Enter submit",
    switchToEnter: "Click to switch to Enter submit",
    mcpServerConnected: "MCP Server connected",
    mcpServerDisconnected: "MCP Server disconnected",
    debugInfo: "Debug Info",
    scanPort: "Scan port",
    workspace: "Workspace",
    currentPort: "Current port",
    connected: "Connected",
    none: "None",
    status: "Status",
    aiWaitingFeedback: "AI is waiting for your feedback",
    submitFailed: "Submit failed",
    cannotConnectMCP: "Cannot connect to MCP Server",
    select: "Select",
    dropToUpload: "Drop images to attach",
    submitting: "Submitting…",
    removeAttachment: "Remove",
    autoRetryOn: "Keep-waiting: ON · auto-continue on timeout (click to turn off)",
    autoRetryOff: "Keep-waiting: OFF · end turn on timeout (click to turn on)",
    accentBrand: "Accent: brand pink (click to follow IDE)",
    accentIde: "Accent: follow IDE color (click for brand pink)",
    clickToZoom: "Click to zoom",
    insertSelection: "Insert selection ({shortcut})",
    contextHint: "@ files · {shortcut} for selection",
    contextHintMention: "@ files",
    contextHintInsert: "for selection",
    insertShortcut: "{shortcut}",
    mentionFiles: "Reference files",
    noMatchFiles: "No matching files",
    contextRefLabel: "Reference",
    submitHintCtrl: "{ctrlEnter}",
    submitHintEnter: "Enter",
    statusNoWorkspace: "(no workspace)",
    statusListening: "Listening on port {port}",
    statusFound: "Request found (port {port})",
    statusNoServer: "MCP Server not found",
    statusConnected: "Connected to {count} port(s), waiting",
    statusPollError: "Polling error: {error}",
    feishuSettings: "Feishu notifications",
    feishuDesc: "Pushes feedback to Feishu, where you can reply directly. Optional.",
    feishuAppId: "App ID",
    feishuAppSecret: "App Secret",
    feishuAppIdPlaceholder: "cli_xxxxxxxx",
    feishuSecretPlaceholder: "Enter App Secret",
    feishuGuide: "How to set up a Feishu bot?",
    feishuClose: "Close",
    feishuStatusUnconfigured: "Not configured",
    feishuStatusConfigured: "Configured · send your bot a message to bind",
    feishuStatusBound: "Configured & bound, ready to push",
    feishuHint: "Tip: after entering credentials, message your bot in Feishu to bind.",
    systemNotifyLabel: "In-app notifications",
    showSecret: "Show secret",
    hideSecret: "Hide secret",
    notifySettingsTitle: "Notification settings",
    pluginNotifyDesc: "Shows the feedback panel when AI requests feedback; when off, this window stays fully silent.",
    osNotifyLabel: "Notify when in background",
    osNotifyDesc: "Sends a system notification when the IDE is in the background.",
    feishuAckLabel: "Get emoji acknowledgement",
    feishuAckDesc: "After you reply in Feishu, the bot adds a Get emoji as acknowledgement.",
    quickReplyDefault1: "Keep waiting for my feedback",
    quickReplyDefault2: "End the task",
    quickReplyEdit: "Edit quick replies",
    quickReplyDone: "Done editing",
    quickReplyAddPlaceholder: "Type a phrase and press Enter",
    quickReplySendTip: "Click to send",
    pauseCountdown: "Pause countdown",
    resumeCountdown: "Resume countdown",
    pausedLabel: "Paused",
    notifyTroubleshootMac: "Not seeing system notifications? If you denied permission before, enable it in System Settings → Notifications → terminal-notifier.",
    notifyTroubleshootWin: "Not seeing system notifications? Enable them in System Settings → Notifications → Windows PowerShell.",
    notifyTestBtn: "Send test notification",
    notifyTestSentHint: "Sent — check your system notifications. If nothing shows, see the tip above.",
    notifyTestBody: "This is a test notification · click to open Cursor",
    toastSubmitted: "✓ Feedback sent",
    toastQueued: "✓ Queued — AI will receive it next round",
    historyBtn: "Feedback history",
    historyEmpty: "No history yet — submitted feedback will show up here"
  };
}
