import * as vscode from 'vscode';

/**
 * 独立的反馈面板（用于在编辑器区域显示）
 */
export class FeedbackPanel {
  public static currentPanel: FeedbackPanel | undefined;
  public static readonly viewType = 'cursorFeedback';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果面板已存在，显示它
    if (FeedbackPanel.currentPanel) {
      FeedbackPanel.currentPanel._panel.reveal(column);
      return;
    }

    // 创建新面板
    const panel = vscode.window.createWebviewPanel(
      FeedbackPanel.viewType,
      'Cursor Feedback',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
        retainContextWhenHidden: true,
      }
    );

    FeedbackPanel.currentPanel = new FeedbackPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    // 设置 HTML 内容
    this._update();

    // 监听面板关闭
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // 监听面板状态变化
    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          this._update();
        }
      },
      null,
      this._disposables
    );

    // 处理来自 webview 的消息
    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case 'submitFeedback':
            vscode.window.showInformationMessage(
              `Feedback received: ${message.payload.interactive_feedback}`
            );
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    FeedbackPanel.currentPanel = undefined;

    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update() {
    const webview = this._panel.webview;
    this._panel.title = 'Cursor Feedback';
    this._panel.webview.html = this._getHtmlForWebview(webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor Feedback</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    
    h1 {
      color: var(--vscode-foreground);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 10px;
    }
    
    .info {
      background: var(--vscode-textBlockQuote-background);
      padding: 15px;
      border-radius: 4px;
      margin: 20px 0;
    }
  </style>
</head>
<body>
  <h1>Cursor Feedback Panel</h1>
  <div class="info">
    <p>此面板用于显示独立的反馈界面。</p>
    <p>通常情况下，请使用侧边栏中的反馈面板进行交互。</p>
  </div>
</body>
</html>`;
  }
}
