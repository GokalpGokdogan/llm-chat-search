// src/chatView.ts

import * as vscode from 'vscode';
import type { ChatSession, SourceType } from './indexer.js';

const SOURCE_COLORS: Record<string, string> = {
    cursor:      '#f0883e',
    continue:    '#3794ff',
    windsurf:    '#4ec9b0',
    copilot:     '#a371f7',
    aider:       '#9cdcfe',
    claudecode:  '#cc785c',
    custom:      '#888888',
};

const SOURCE_LABELS: Record<string, string> = {
    cursor:      'Cursor',
    continue:    'Continue.dev',
    windsurf:    'Windsurf',
    copilot:     'GitHub Copilot',
    aider:       'source file',
    claudecode:  'source file',
    custom:      'source file',
};

function esc(text: string): string {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderContent(text: string): string {
    // Split on fenced code blocks first
    const parts = text.split(/(```[\s\S]*?```)/g);
    return parts.map(part => {
        if (part.startsWith('```')) {
            const firstNl = part.indexOf('\n');
            const code = firstNl >= 0 ? part.slice(firstNl + 1, -3) : part.slice(3, -3);
            return `<pre><code>${esc(code)}</code></pre>`;
        }
        let html = esc(part);
        html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        html = html.replace(/\n/g, '<br>');
        return html;
    }).join('');
}

export class ChatViewPanel {
    static readonly viewType = 'llmChatView';
    private static _current: ChatViewPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];
    private _onOpenSource: (chatId: string, sourceType: SourceType, filePath: string, content: string) => Promise<void>;

    static createOrShow(
        extensionUri: vscode.Uri,
        matchedSessions: Array<{ session: ChatSession; relevance: number }>,
        initialChatId: string,
        matchContent: string,
        onOpenSource: (chatId: string, sourceType: SourceType, filePath: string, content: string) => Promise<void>
    ): void {
        const column = vscode.ViewColumn.Beside;

        if (ChatViewPanel._current) {
            ChatViewPanel._current._update(matchedSessions, initialChatId, matchContent, onOpenSource);
            ChatViewPanel._current._panel.reveal(column, true);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ChatViewPanel.viewType,
            'LLM Chat Viewer',
            { viewColumn: column, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ChatViewPanel._current = new ChatViewPanel(panel, matchedSessions, initialChatId, matchContent, onOpenSource);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        matchedSessions: Array<{ session: ChatSession; relevance: number }>,
        initialChatId: string,
        matchContent: string,
        onOpenSource: (chatId: string, sourceType: SourceType, filePath: string, content: string) => Promise<void>
    ) {
        this._panel = panel;
        this._onOpenSource = onOpenSource;
        this._render(matchedSessions, initialChatId, matchContent);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'copy':
                    await vscode.env.clipboard.writeText(String(msg.text ?? ''));
                    break;
                case 'openSource':
                    await this._onOpenSource(msg.chatId, msg.sourceType as SourceType, msg.filePath, msg.content);
                    break;
                case 'openFile':
                    await this._openFile(String(msg.filePath), Number(msg.lineNumber), String(msg.snippet ?? ''));
                    break;
            }
        }, null, this._disposables);
    }

    private _update(
        matchedSessions: Array<{ session: ChatSession; relevance: number }>,
        initialChatId: string,
        matchContent: string,
        onOpenSource: (chatId: string, sourceType: SourceType, filePath: string, content: string) => Promise<void>
    ) {
        this._onOpenSource = onOpenSource;
        this._render(matchedSessions, initialChatId, matchContent);
    }

    private _render(
        matchedSessions: Array<{ session: ChatSession; relevance: number }>,
        initialChatId: string,
        matchContent: string
    ) {
        const active = matchedSessions.find(x => x.session.chat_id === initialChatId);
        this._panel.title = (active?.session.chat_title ?? 'LLM Chat').slice(0, 40);
        this._panel.webview.html = buildHtml(matchedSessions, initialChatId, matchContent);
    }

    private async _openFile(filePath: string, lineNumber: number, snippet: string) {
        try {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const isLineNavigable = filePath.endsWith('.md') || filePath.endsWith('.txt');
            if (isLineNavigable && lineNumber > 0) {
                const pos = new vscode.Position(Math.max(0, lineNumber - 1), 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } else if (snippet) {
                const idx = doc.getText().indexOf(snippet.slice(0, 40));
                if (idx >= 0) {
                    const pos = doc.positionAt(idx);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
            }
        } catch {
            vscode.window.showErrorMessage(`Could not open: ${filePath}`);
        }
    }

    dispose() {
        ChatViewPanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }
}

function buildHtml(
    matchedSessions: Array<{ session: ChatSession; relevance: number }>,
    activeChatId: string,
    matchContent: string
): string {
    const snippet = matchContent.replace(/\s+/g, ' ').slice(0, 80);
    const activeIdx = Math.max(0, matchedSessions.findIndex(x => x.session.chat_id === activeChatId));

    // Serialize message content for JS clipboard use
    const messageData: Record<number, string[]> = {};
    matchedSessions.forEach(({ session }, si) => {
        messageData[si] = session.messages.map(m => m.content);
    });
    const messageDataJson = JSON.stringify(messageData)
        .replace(/<\/script>/gi, '<\\/script>')
        .replace(/<!--/g, '<\\!--');

    // ── Sidebar ──────────────────────────────────────────────────────────────
    const sidebarHtml = matchedSessions.map(({ session, relevance }, si) => {
        const color = SOURCE_COLORS[session.source_type] ?? '#888';
        const isActive = si === activeIdx;
        const pct = Math.round(relevance * 100);
        const lastMsg = session.messages.at(-1);
        const lastDate = lastMsg && lastMsg.timestamp.getTime() !== 0
            ? lastMsg.timestamp.toLocaleDateString([], { month: 'short', day: 'numeric' })
            : '';

        return `
<div class="session-item${isActive ? ' active' : ''}" data-action="select-session" data-idx="${si}" style="border-left:3px solid ${color}">
  <div class="session-item-top">
    <span class="source-dot" style="background:${color}"></span>
    <span class="source-name">${esc(session.source_type)}</span>
    <span class="relevance-badge">${pct}%</span>
  </div>
  <div class="session-title">${esc(session.chat_title.slice(0, 60))}</div>
  <div class="session-meta">${session.total_messages} msgs${lastDate ? ' · ' + esc(lastDate) : ''}</div>
</div>`;
    }).join('');

    // ── Conversations ─────────────────────────────────────────────────────────
    const conversationsHtml = matchedSessions.map(({ session }, si) => {
        const isActive = si === activeIdx;
        const color = SOURCE_COLORS[session.source_type] ?? '#888';
        const sourceLabel = esc(SOURCE_LABELS[session.source_type] ?? 'source file');

        // Find matched message index (only compute for active session initially)
        let matchedMsgIdx = -1;
        const snip60 = snippet.slice(0, 60);
        for (let i = 0; i < session.messages.length; i++) {
            if (session.messages[i].content.replace(/\s+/g, ' ').includes(snip60)) {
                matchedMsgIdx = i;
                break;
            }
        }

        const lastMsg = session.messages.at(-1);
        const lastDate = lastMsg && lastMsg.timestamp.getTime() !== 0
            ? lastMsg.timestamp.toLocaleDateString()
            : '';

        const messagesHtml = session.messages.map((msg, mi) => {
            const isHighlighted = mi === matchedMsgIdx;

            if (msg.role === 'system') {
                return `<div class="system-msg">${esc(msg.content.slice(0, 120))}</div>`;
            }

            const roleLabel = msg.role === 'user' ? 'You' : 'Assistant';
            const ts = msg.timestamp.getTime() !== 0
                ? msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : '';

            const canOpenFile = msg.source_file && !msg.source_file.endsWith('.vscdb');
            const openBtn = canOpenFile
                ? `<button class="action-btn" data-action="open-file" data-filepath="${esc(msg.source_file)}" data-line="${msg.line_number}" data-snippet="${esc(snippet.slice(0, 40))}">Open ↗</button>`
                : '';

            return `
<div class="msg-row ${msg.role}${isHighlighted ? ' highlighted' : ''}" id="msg-${si}-${mi}">
  <div class="bubble">
    <div class="bubble-header">
      <span class="role-label">${roleLabel}</span>
      ${ts ? `<span class="timestamp">${ts}</span>` : ''}
      <div class="bubble-actions">
        <button class="action-btn" data-action="copy" data-session-idx="${si}" data-msg-idx="${mi}">Copy</button>
        ${openBtn}
      </div>
    </div>
    <div class="bubble-content">${renderContent(msg.content)}</div>
  </div>
</div>`;
        }).join('');

        return `
<div class="conversation" id="conv-${si}" style="display:${isActive ? 'flex' : 'none'}">
  <div class="conv-header">
    <div class="conv-header-info">
      <h2 class="conv-title">${esc(session.chat_title)}</h2>
      <div class="conv-meta">
        <span class="source-badge" style="background:${color}22;color:${color};border:1px solid ${color}55">${esc(session.source_type)}</span>
        <span class="meta-text">${session.total_messages} messages</span>
        ${lastDate ? `<span class="meta-text">${esc(lastDate)}</span>` : ''}
      </div>
    </div>
    <button class="open-source-btn" data-action="open-source" data-chat-id="${esc(session.chat_id)}" data-source-type="${esc(session.source_type)}" data-filepath="${esc(session.source_file)}" data-content="${esc(matchContent.slice(0, 200))}">
      Open in ${sourceLabel} ↗
    </button>
  </div>
  <div class="messages-list" id="msgs-${si}">
    ${messagesHtml}
  </div>
</div>`;
    }).join('');

    // ── HTML ──────────────────────────────────────────────────────────────────
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>LLM Chat Viewer</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

body{
  font-family:var(--vscode-font-family);
  font-size:13px;
  background:var(--vscode-editor-background);
  color:var(--vscode-editor-foreground);
  height:100vh;
  overflow:hidden;
  display:flex;
  flex-direction:column;
}

/* ── Top bar ── */
.top-bar{
  display:flex;
  align-items:center;
  gap:10px;
  padding:8px 16px;
  background:var(--vscode-titleBar-activeBackground,var(--vscode-sideBar-background));
  border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));
  flex-shrink:0;
  min-height:36px;
}
.app-title{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.65}
.query-info{font-size:12px;opacity:.45}

/* ── Main grid ── */
.main{display:grid;grid-template-columns:220px 1fr;flex:1;min-height:0;overflow:hidden}

/* ── Sidebar ── */
.sidebar{
  background:var(--vscode-sideBar-background);
  border-right:1px solid var(--vscode-panel-border,var(--vscode-widget-border));
  overflow-y:auto;
  display:flex;
  flex-direction:column;
}
.sidebar-header{
  padding:10px 12px 8px;
  font-size:10px;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:.1em;
  opacity:.5;
  flex-shrink:0;
  border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.15));
}
.session-item{
  padding:10px 12px;
  cursor:pointer;
  border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.08));
  transition:background .12s;
  user-select:none;
}
.session-item:hover{background:var(--vscode-list-hoverBackground)}
.session-item.active{
  background:var(--vscode-list-activeSelectionBackground);
  color:var(--vscode-list-activeSelectionForeground);
}
.session-item-top{display:flex;align-items:center;gap:5px;margin-bottom:4px}
.source-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.source-name{font-size:10px;opacity:.65;flex:1;text-transform:lowercase;letter-spacing:.02em}
.relevance-badge{font-size:10px;font-weight:700;opacity:.75}
.session-title{font-size:12px;font-weight:500;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.session-meta{font-size:10px;margin-top:3px;opacity:.45}

/* ── Content area ── */
.content{display:flex;flex-direction:column;min-height:0;overflow:hidden}

/* ── Conversation ── */
.conversation{flex-direction:column;height:100%;overflow:hidden}

.conv-header{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
  padding:12px 16px;
  border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));
  flex-shrink:0;
  background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));
}
.conv-header-info{flex:1;min-width:0}
.conv-title{
  font-size:14px;
  font-weight:600;
  line-height:1.3;
  margin-bottom:6px;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.conv-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.source-badge{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500;white-space:nowrap;letter-spacing:.02em}
.meta-text{font-size:11px;opacity:.5}
.open-source-btn{
  flex-shrink:0;
  padding:5px 12px;
  border-radius:5px;
  border:1px solid var(--vscode-button-border,var(--vscode-widget-border,rgba(128,128,128,.4)));
  background:var(--vscode-button-secondaryBackground,transparent);
  color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground));
  font-size:12px;
  cursor:pointer;
  transition:background .12s;
  white-space:nowrap;
  font-family:inherit;
}
.open-source-btn:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-list-hoverBackground))}

/* ── Messages list ── */
.messages-list{flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px}

/* ── Message rows ── */
.msg-row{display:flex}
.msg-row.user{justify-content:flex-end}
.msg-row.llm{justify-content:flex-start}
.msg-row.system{justify-content:center}

/* ── Bubbles ── */
.bubble{
  max-width:72%;
  border-radius:14px;
  padding:10px 14px;
  position:relative;
  transition:outline .15s;
}
.msg-row.user .bubble{
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  border-radius:14px 14px 4px 14px;
}
.msg-row.llm .bubble{
  background:var(--vscode-editorWidget-background);
  border:1px solid var(--vscode-widget-border,var(--vscode-panel-border,rgba(128,128,128,.2)));
  border-radius:14px 14px 14px 4px;
}
.msg-row.highlighted .bubble{
  outline:2px solid var(--vscode-focusBorder);
  outline-offset:2px;
}

.system-msg{font-size:11px;opacity:.4;font-style:italic;text-align:center;padding:2px 16px}

/* ── Bubble header ── */
.bubble-header{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.role-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;opacity:.55}
.timestamp{font-size:11px;opacity:.4}
.bubble-actions{margin-left:auto;display:flex;gap:4px;opacity:0;transition:opacity .15s}
.bubble:hover .bubble-actions{opacity:1}

.action-btn{
  padding:2px 8px;
  border-radius:3px;
  border:1px solid currentColor;
  background:transparent;
  color:inherit;
  font-size:11px;
  cursor:pointer;
  opacity:.6;
  transition:opacity .1s;
  white-space:nowrap;
  font-family:inherit;
}
.action-btn:hover{opacity:1}

/* ── Bubble content ── */
.bubble-content{font-size:13px;line-height:1.65;word-break:break-word}
.bubble-content pre{
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));
  border-radius:6px;
  padding:10px 12px;
  margin:8px 0;
  overflow-x:auto;
  font-size:12px;
  line-height:1.5;
}
.bubble-content code{
  font-family:var(--vscode-editor-font-family,monospace);
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));
  border-radius:3px;
  padding:1px 5px;
  font-size:12px;
}
.bubble-content pre code{background:transparent;padding:0;border-radius:0}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
</style>
</head>
<body>
<div class="top-bar">
  <span class="app-title">LLM Chat Search</span>
  <span class="query-info">${matchedSessions.length} result${matchedSessions.length !== 1 ? 's' : ''}</span>
</div>
<div class="main">
  <div class="sidebar">
    <div class="sidebar-header">Results</div>
    ${sidebarHtml}
  </div>
  <div class="content">
    ${conversationsHtml}
  </div>
</div>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const messageData = ${messageDataJson};
  const ACTIVE_IDX = ${activeIdx};

  function selectSession(idx) {
    document.querySelectorAll('.conversation').forEach(function (el) { el.style.display = 'none'; });
    document.querySelectorAll('.session-item').forEach(function (el) { el.classList.remove('active'); });
    const conv = document.getElementById('conv-' + idx);
    const item = document.querySelector('[data-idx="' + idx + '"]');
    if (conv) {
      conv.style.display = 'flex';
      const hl = conv.querySelector('.highlighted');
      if (hl) { setTimeout(function () { hl.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50); }
    }
    if (item) { item.classList.add('active'); }
  }

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) { return; }
    const action = el.dataset.action;

    if (action === 'select-session') {
      selectSession(parseInt(el.dataset.idx, 10));

    } else if (action === 'copy') {
      const si = parseInt(el.dataset.sessionIdx, 10);
      const mi = parseInt(el.dataset.msgIdx, 10);
      const text = (messageData[si] || [])[mi] || '';
      vscode.postMessage({ type: 'copy', text: text });

    } else if (action === 'open-file') {
      vscode.postMessage({
        type: 'openFile',
        filePath: el.dataset.filepath,
        lineNumber: parseInt(el.dataset.line || '0', 10),
        snippet: el.dataset.snippet || '',
      });

    } else if (action === 'open-source') {
      vscode.postMessage({
        type: 'openSource',
        chatId: el.dataset.chatId,
        sourceType: el.dataset.sourceType,
        filePath: el.dataset.filepath,
        content: el.dataset.content,
      });
    }
  });

  // Auto-scroll to highlighted message on load
  document.addEventListener('DOMContentLoaded', function () {
    const conv = document.getElementById('conv-' + ACTIVE_IDX);
    if (conv) {
      const hl = conv.querySelector('.highlighted');
      if (hl) { hl.scrollIntoView({ behavior: 'auto', block: 'center' }); }
    }
  });
}());
</script>
</body>
</html>`;
}
