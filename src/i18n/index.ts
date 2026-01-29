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
  startListening: string;
  stopListening: string;
  aiWaitingFeedback: string;
  feedbackSubmitted: string;
  submitFailed: string;
  cannotConnectMCP: string;
  select: string;
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
    startListening: "Started listening for MCP feedback requests",
    stopListening: "Stopped listening",
    aiWaitingFeedback: "AI is waiting for your feedback",
    feedbackSubmitted: "Feedback submitted",
    submitFailed: "Submit failed",
    cannotConnectMCP: "Cannot connect to MCP Server",
    select: "Select"
  };
}
