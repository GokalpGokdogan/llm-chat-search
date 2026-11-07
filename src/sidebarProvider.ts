// src/sidebarProvider.ts

import * as vscode from 'vscode';
import { ChatDataIngester, type ChatSession, type SourceType } from './indexer.js';
import { SearchEngine } from './search.js';

const SOURCE_COLORS: Record<string, string> = {
    cursor:     '#f0883e',
    continue:   '#3794ff',
    windsurf:   '#4ec9b0',
    copilot:    '#a371f7',
    aider:      '#9cdcfe',
    claudecode: '#cc785c',
    custom:     '#888888',
};

export class SidebarProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'llmChatSearch.sidebar';

    private _view?: vscode.WebviewView;
    private _lastMatchedSessions: Array<{ session: ChatSession; relevance: number }> = [];
    private _snippets: Map<string, string> = new Map();
    private _queries:  Map<string, string> = new Map();

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _indexPath: string,
        private readonly _workspacePath: string | undefined,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._buildHtml();

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {

                case 'ready': {
                    this._sendSessions(webviewView);
                    break;
                }

                case 'search': {
                    const sessions = this._loadSessions();
                    if (!sessions.length) {
                        webviewView.webview.postMessage({ type: 'error', message: 'No sessions indexed. Click ↻ to index.' });
                        break;
                    }
                    webviewView.webview.postMessage({ type: 'loading', on: true });
                    try {
                        const cfg = vscode.workspace.getConfiguration('llmChatSearch');
                        const useSemantic = cfg.get<boolean>('semanticSearch') ?? false;
                        const openAiKey = cfg.get<string>('openAiKey');
                        const maxResults = cfg.get<number>('maxResults') ?? 20;

                        const engine = new SearchEngine(this._indexPath, sessions);
                        const results = await engine.search(msg.query, useSemantic, openAiKey);

                        this._lastMatchedSessions = results.matches
                            .slice(0, maxResults)
                            .map(m => ({ session: sessions.find(s => s.chat_id === m.id)!, relevance: m.relevance }))
                            .filter(x => x.session);

                        this._snippets.clear();
                        this._queries.clear();
                        results.matches.slice(0, maxResults).forEach(m => {
                            this._snippets.set(m.id, m.content);
                        });
                        this._lastMatchedSessions.forEach(x =>
                            this._queries.set(x.session.chat_id, msg.query)
                        );

                        const matches = this._lastMatchedSessions.map(({ session, relevance }) => ({
                            chatId: session.chat_id,
                            title: session.chat_title,
                            source: session.source_type,
                            color: SOURCE_COLORS[session.source_type] ?? '#888',
                            relevance: Math.round(relevance * 100),
                            snippet: (this._snippets.get(session.chat_id) ?? '').replace(/\s+/g, ' ').slice(0, 100),
                        }));

                        webviewView.webview.postMessage({ type: 'results', matches, query: msg.query });
                    } finally {
                        webviewView.webview.postMessage({ type: 'loading', on: false });
                    }
                    break;
                }

                case 'openSession': {
                    const allSessions = this._lastMatchedSessions.length
                        ? this._lastMatchedSessions
                        : this._loadSessions().map(s => ({ session: s, relevance: 1 }));
                    const entry = allSessions.find(x => x.session.chat_id === msg.chatId);
                    if (!entry) { break; }
                    const session = entry.session;
                    const snippet = this._snippets.get(msg.chatId) ?? msg.snippet ?? '';

                    // Reconstruct session content exactly as SearchEngine.buildIndex() does, then map
                    // the snippet position back to a message index. This is the only reliable approach
                    // because extractSnippet() clips from the joined string (including role prefixes).
                    const sessionStr = `${session.chat_title}\n${session.messages
                        .map((m: any) => `${m.role}: ${m.content}`)
                        .join('\n')}`;
                    const sessionNorm = sessionStr.replace(/\s+/g, ' ');
                    const cleanSnippet = snippet.replace(/\s+/g, ' ').replace(/^[….]+\s*/, '');
                    const needle = cleanSnippet.slice(0, 40);

                    let matchedMsgIdx = -1;
                    if (needle.length >= 5) {
                        const snippetPos = sessionNorm.indexOf(needle);
                        if (snippetPos >= 0) {
                            let pos = session.chat_title.replace(/\s+/g, ' ').length + 1;
                            for (let i = 0; i < session.messages.length; i++) {
                                const msgStr = `${session.messages[i].role}: ${session.messages[i].content}`.replace(/\s+/g, ' ');
                                if (snippetPos < pos + msgStr.length) { matchedMsgIdx = i; break; }
                                pos += msgStr.length + 1;
                            }
                        }
                    }
                    // Fallback: query-word scoring when snippet is too short or didn't match
                    if (matchedMsgIdx === -1) {
                        const query = this._queries.get(msg.chatId) ?? '';
                        const queryWords = query.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 2);
                        if (queryWords.length > 0) {
                            let bestScore = 0;
                            for (let i = 0; i < session.messages.length; i++) {
                                const lower = session.messages[i].content.toLowerCase();
                                const score = queryWords.filter((w: string) => lower.includes(w)).length;
                                if (score > bestScore) { bestScore = score; matchedMsgIdx = i; }
                            }
                        }
                    }

                    webviewView.webview.postMessage({
                        type: 'conversation',
                        matchedMsgIdx,
                        snippet,
                        query: this._queries.get(msg.chatId) ?? '',
                        session: {
                            chat_id: session.chat_id,
                            chat_title: session.chat_title,
                            source_type: session.source_type,
                            source_file: session.source_file,
                            total_messages: session.total_messages,
                            messages: session.messages.map(m => ({
                                role: m.role,
                                content: m.content,
                                timestamp: m.timestamp.toISOString(),
                                source_file: m.source_file,
                                line_number: m.line_number,
                            })),
                        },
                    });
                    break;
                }

                case 'reindex': {
                    await vscode.commands.executeCommand('llm-chat-search.reindex');
                    break;
                }

                case 'copyMsg': {
                    await vscode.env.clipboard.writeText(String(msg.text ?? ''));
                    break;
                }

                case 'openSource': {
                    if (msg.sourceType === 'claudecode' && msg.filePath) {
                        // Open JSONL at the matched message's 0-based line
                        await this._openFile(String(msg.filePath), Number(msg.matchedLineNumber ?? 0), '');
                    } else if (msg.sourceType === 'copilot' && msg.filePath) {
                        // No VS Code API can deep-link into a specific Copilot conversation,
                        // so open the source JSON and search for the matched message text
                        await this._openFile(String(msg.filePath), 0, String(msg.matchedContent || msg.content || ''));
                    } else {
                        await vscode.commands.executeCommand('llm-chat-search.openMatch', {
                            chatId: msg.chatId,
                            sourceType: msg.sourceType as SourceType,
                            filePath: msg.filePath,
                            messageContent: msg.content,
                        });
                    }
                    break;
                }

                case 'openFile': {
                    await this._openFile(String(msg.filePath), Number(msg.lineNumber), String(msg.snippet ?? ''));
                    break;
                }
            }
        }, undefined, this._context.subscriptions);
    }

    refresh() {
        if (!this._view) { return; }
        this._sendSessions(this._view);
    }

    private _sendSessions(view: vscode.WebviewView) {
        const sessions = this._loadSessions();
        if (!sessions.length) {
            view.webview.postMessage({ type: 'empty' });
            return;
        }
        view.webview.postMessage({
            type: 'sessions',
            sessions: sessions.map(s => ({
                chatId: s.chat_id,
                title: s.chat_title,
                source: s.source_type,
                color: SOURCE_COLORS[s.source_type] ?? '#888',
                count: s.total_messages,
            })),
        });
    }

    private _loadSessions(): ChatSession[] {
        return new ChatDataIngester().loadIndex(this._indexPath);
    }

    private async _openFile(filePath: string, lineNumber: number, snippet: string) {
        try {
            const uri = vscode.Uri.file(filePath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            const isJsonl    = filePath.endsWith('.jsonl');
            const isMarkdown = filePath.endsWith('.md') || filePath.endsWith('.txt');
            if (isJsonl) {
                // line_number is 0-based for JSONL
                const pos = new vscode.Position(Math.max(0, lineNumber), 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } else if (isMarkdown && lineNumber > 0) {
                // line_number is 1-based for markdown/text
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

    private _buildHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

body{
  font-family:var(--vscode-font-family);
  font-size:12px;
  color:var(--vscode-foreground);
  background:var(--vscode-sideBar-background);
  display:flex;
  flex-direction:column;
  height:100vh;
  overflow:hidden;
}

/* ── Toolbar ── */
.toolbar{
  display:flex;
  gap:5px;
  padding:7px 8px;
  border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));
  flex-shrink:0;
}
#searchInput{
  flex:1;
  padding:4px 8px;
  border-radius:4px;
  border:1px solid var(--vscode-input-border,rgba(128,128,128,.3));
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  font-family:inherit;
  font-size:12px;
  outline:none;
}
#searchInput:focus{border-color:var(--vscode-focusBorder)}
#searchInput::placeholder{color:var(--vscode-input-placeholderForeground)}
.icon-btn{
  padding:3px 7px;
  border-radius:4px;
  border:none;
  background:transparent;
  color:var(--vscode-foreground);
  font-size:14px;
  cursor:pointer;
  opacity:.6;
  transition:opacity .1s;
  line-height:1;
}
.icon-btn:hover{opacity:1;background:var(--vscode-list-hoverBackground)}

/* ── Loading bar ── */
.loading{
  font-size:11px;
  padding:4px 10px;
  opacity:.55;
  border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.15));
  flex-shrink:0;
}
.loading.hidden{display:none}

/* ── Scrollable main area ── */
#main{flex:1;overflow-y:auto;overflow-x:hidden}

/* ── Result / session items ── */
.result-item{
  padding:8px 10px;
  cursor:pointer;
  border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.07));
  transition:background .1s;
}
.result-item:hover{background:var(--vscode-list-hoverBackground)}
.item-top{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.source-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.source-name{font-size:10px;opacity:.6;flex:1;text-transform:lowercase}
.rel-badge,.count-badge{font-size:10px;font-weight:700;opacity:.75}
.item-title{font-size:12px;font-weight:500;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item-snippet{font-size:11px;opacity:.5;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── Empty / error ── */
.empty{padding:20px 12px;text-align:center;opacity:.5;font-size:12px;line-height:1.7}
.index-btn{
  margin-top:8px;
  padding:4px 14px;
  border-radius:4px;
  border:none;
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  font-family:inherit;
  font-size:12px;
  cursor:pointer;
}

/* ── Conversation header ── */
.conv-header{
  display:flex;
  align-items:center;
  gap:6px;
  padding:8px 10px;
  border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.2));
  background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-sideBar-background));
  position:sticky;
  top:0;
  z-index:1;
  flex-shrink:0;
}
.back-btn{
  padding:2px 6px;
  border-radius:3px;
  border:1px solid var(--vscode-widget-border,rgba(128,128,128,.3));
  background:transparent;
  color:var(--vscode-foreground);
  font-size:11px;
  cursor:pointer;
  white-space:nowrap;
  font-family:inherit;
  flex-shrink:0;
}
.back-btn:hover{background:var(--vscode-list-hoverBackground)}
.conv-info{flex:1;min-width:0}
.conv-title{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
.conv-meta{display:flex;align-items:center;gap:6px;margin-top:2px}
.src-badge{font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid;white-space:nowrap}
.meta-txt{font-size:10px;opacity:.45}
.osrc-btn{
  padding:2px 7px;
  border-radius:3px;
  border:1px solid var(--vscode-widget-border,rgba(128,128,128,.3));
  background:transparent;
  color:var(--vscode-foreground);
  font-size:12px;
  cursor:pointer;
  flex-shrink:0;
  font-family:inherit;
}
.osrc-btn:hover{background:var(--vscode-list-hoverBackground)}

/* ── Messages ── */
.msgs{
  display:flex;
  flex-direction:column;
  gap:10px;
  padding:12px 10px;
}
.msg-row{display:flex}
.msg-row.user{justify-content:flex-end}
.msg-row.llm{justify-content:flex-start}
.msg-row.system{justify-content:center}

.bubble{
  max-width:88%;
  border-radius:12px;
  padding:8px 11px;
  position:relative;
}
.msg-row.user .bubble{
  background:var(--vscode-button-background);
  color:var(--vscode-button-foreground);
  border-radius:12px 12px 3px 12px;
}
.msg-row.llm .bubble{
  background:var(--vscode-editorWidget-background);
  border:1px solid var(--vscode-widget-border,rgba(128,128,128,.2));
  border-radius:12px 12px 12px 3px;
}
.msg-row.highlighted .bubble{
  outline:2px solid var(--vscode-focusBorder);
  outline-offset:2px;
}

.system-msg{font-size:10px;opacity:.4;font-style:italic;text-align:center;padding:2px 8px}

.bubble-hdr{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.role-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.55}
.ts{font-size:10px;opacity:.4}
.bactions{margin-left:auto;display:flex;gap:3px;opacity:0;transition:opacity .15s}
.bubble:hover .bactions{opacity:1}
.abtn{
  padding:1px 6px;
  border-radius:3px;
  border:1px solid currentColor;
  background:transparent;
  color:inherit;
  font-size:10px;
  cursor:pointer;
  opacity:.6;
  white-space:nowrap;
  font-family:inherit;
}
.abtn:hover{opacity:1}

.bcontent{font-size:12px;line-height:1.6;word-break:break-word}
.bcontent pre{
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));
  border-radius:5px;
  padding:8px 10px;
  margin:6px 0;
  overflow-x:auto;
  font-size:11px;
  line-height:1.5;
}
.bcontent code{
  font-family:var(--vscode-editor-font-family,monospace);
  background:var(--vscode-textCodeBlock-background,rgba(128,128,128,.1));
  border-radius:3px;
  padding:1px 4px;
  font-size:11px;
}
.bcontent pre code{background:transparent;padding:0;border-radius:0}

mark{background:var(--vscode-editor-findMatchHighlightBackground,rgba(255,200,0,.4));color:inherit;border-radius:2px;padding:0 1px}

::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
</style>
</head>
<body>
<div class="toolbar">
  <input id="searchInput" type="text" placeholder="Search chats…" autocomplete="off" spellcheck="false" />
  <button class="icon-btn" data-action="reindex" title="Re-index workspace chats">↻</button>
</div>
<div id="loading" class="loading hidden">Searching…</div>
<div id="main"></div>

<script>
(function () {
  const vscode = acquireVsCodeApi();

  const SRC_COLORS = {cursor:'#f0883e',continue:'#3794ff',windsurf:'#4ec9b0',copilot:'#a371f7',aider:'#9cdcfe',claudecode:'#cc785c',custom:'#888'};
  const SRC_LABELS  = {cursor:'Cursor',continue:'Continue.dev',windsurf:'Windsurf',copilot:'GitHub Copilot',aider:'source file',claudecode:'source file',custom:'source file'};

  let resultsData       = [];
  let isResultsMode     = false;
  let currentMsgs       = [];
  let currentSnippet    = '';
  let currentSession    = null;
  let currentMatchedIdx = -1;
  let currentQueryWords = [];

  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderContent(text) {
    return text.split(/([\`]{3}[\\s\\S]*?[\`]{3})/g).map(function(part) {
      if (part.startsWith('\`\`\`')) {
        var nl = part.indexOf('\\n');
        var code = nl >= 0 ? part.slice(nl+1,-3) : part.slice(3,-3);
        return '<pre><code>' + esc(code) + '</code></pre>';
      }
      return esc(part).replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>').replace(/\\n/g,'<br>');
    }).join('');
  }

  function highlightQuery(html) {
    if (!currentQueryWords.length) return html;
    // Only replace in text nodes — skip content inside < > to avoid breaking tags
    return html.replace(/(<[^>]*>)|([^<]+)/g, function(m, tag, text) {
      if (tag) return tag;
      if (!text) return m;
      currentQueryWords.forEach(function(w) {
        var re = new RegExp('(' + w.replace(/[.*+?^{}()|[\\]\\\\$]/g,'\\\\$&') + ')', 'gi');
        text = text.replace(re, '<mark>$1</mark>');
      });
      return text;
    });
  }

  function renderResults(items, withRelevance) {
    isResultsMode = withRelevance;
    var main = document.getElementById('main');
    if (!items || !items.length) {
      main.innerHTML = '<div class="empty">No results found.</div>';
      return;
    }
    main.innerHTML = items.map(function(item) {
      var color = item.color || '#888';
      var badge = withRelevance
        ? '<span class="rel-badge">' + item.relevance + '%</span>'
        : '<span class="count-badge">' + (item.count||'') + ' msgs</span>';
      var snippet = withRelevance && item.snippet
        ? '<div class="item-snippet">' + esc(item.snippet) + '</div>' : '';
      return '<div class="result-item" data-action="openSession"' +
        ' data-id="' + esc(item.chatId||item.id||'') + '"' +
        ' data-snippet="' + esc((item.snippet||'').slice(0,100)) + '"' +
        ' style="border-left:3px solid ' + color + '">' +
        '<div class="item-top">' +
          '<span class="source-dot" style="background:' + color + '"></span>' +
          '<span class="source-name">' + esc(item.source) + '</span>' +
          badge +
        '</div>' +
        '<div class="item-title">' + esc(item.title) + '</div>' +
        snippet +
      '</div>';
    }).join('');
  }

  function renderConversation(session, matchedIdx) {
    var color = SRC_COLORS[session.source_type] || '#888';
    var label = SRC_LABELS[session.source_type] || 'source file';
    var snippetShort = (currentSnippet||'').replace(/\\s+/g,' ').slice(0,40);

    var msgsHtml = session.messages.map(function(msg, i) {
      if (msg.role === 'system') {
        return '<div class="system-msg">' + esc((msg.content||'').slice(0,80)) + '</div>';
      }
      var hl = i === matchedIdx ? ' highlighted' : '';
      var lbl = msg.role === 'user' ? 'You' : 'Assistant';
      var ts = '';
      if (msg.timestamp && msg.timestamp !== '1970-01-01T00:00:00.000Z') {
        try { ts = new Date(msg.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); } catch(e) {}
      }
      var canOpen = msg.source_file && !msg.source_file.endsWith('.vscdb');
      var openBtn = canOpen
        ? '<button class="abtn" data-action="openFile"' +
          ' data-filepath="' + esc(msg.source_file) + '"' +
          ' data-line="' + msg.line_number + '"' +
          ' data-snippet="' + esc((msg.content||'').replace(/\\s+/g,' ').slice(0,60)) + '">Open ↗</button>'
        : '';
      return '<div class="msg-row ' + msg.role + hl + '" id="msg-' + i + '">' +
        '<div class="bubble">' +
          '<div class="bubble-hdr">' +
            '<span class="role-lbl">' + lbl + '</span>' +
            (ts ? '<span class="ts">' + ts + '</span>' : '') +
            '<div class="bactions">' +
              '<button class="abtn" data-action="copyMsg" data-idx="' + i + '">Copy</button>' +
              openBtn +
            '</div>' +
          '</div>' +
          '<div class="bcontent">' + highlightQuery(renderContent(msg.content||'')) + '</div>' +
        '</div></div>';
    }).join('');

    document.getElementById('main').innerHTML =
      '<div class="conv-header">' +
        '<button class="back-btn" data-action="back">← Back</button>' +
        '<div class="conv-info">' +
          '<div class="conv-title" title="' + esc(session.chat_title) + '">' + esc((session.chat_title||'').slice(0,38)) + '</div>' +
          '<div class="conv-meta">' +
            '<span class="src-badge" style="color:' + color + ';border-color:' + color + '44">' + esc(session.source_type) + '</span>' +
            '<span class="meta-txt">' + (session.total_messages||0) + ' msgs</span>' +
          '</div>' +
        '</div>' +
        '<button class="osrc-btn" data-action="openSource"' +
          ' data-chat-id="' + esc(session.chat_id) + '"' +
          ' data-source-type="' + esc(session.source_type) + '"' +
          ' data-filepath="' + esc(session.source_file||'') + '"' +
          ' title="Open in ' + esc(label) + '">↗</button>' +
      '</div>' +
      '<div class="msgs">' + msgsHtml + '</div>';

    currentMsgs       = session.messages;
    currentSession    = session;
    currentMatchedIdx = matchedIdx;

    if (matchedIdx >= 0) {
      setTimeout(function() {
        var el = document.getElementById('msg-' + matchedIdx);
        if (el) { el.scrollIntoView({behavior:'smooth',block:'center'}); }
      }, 80);
    }
  }

  // Receive messages from extension
  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (msg.type === 'sessions') {
      resultsData = msg.sessions;
      isResultsMode = false;
      renderResults(msg.sessions, false);
    } else if (msg.type === 'results') {
      resultsData = msg.matches;
      isResultsMode = true;
      renderResults(msg.matches, true);
    } else if (msg.type === 'loading') {
      document.getElementById('loading').classList.toggle('hidden', !msg.on);
    } else if (msg.type === 'error') {
      document.getElementById('main').innerHTML = '<div class="empty">' + esc(msg.message) + '</div>';
    } else if (msg.type === 'empty') {
      document.getElementById('main').innerHTML =
        '<div class="empty">No sessions indexed yet.<br>' +
        '<button class="index-btn" data-action="reindex">Index now</button></div>';
    } else if (msg.type === 'conversation') {
      currentSnippet = msg.snippet || '';
      currentQueryWords = (msg.query || '').toLowerCase().split(/\\s+/).filter(function(w) { return w.length >= 2; });
      renderConversation(msg.session, msg.matchedMsgIdx);
    }
  });

  // Search input
  var searchInput = document.getElementById('searchInput');
  function submitSearch() {
    var q = searchInput.value.trim();
    if (!q) { vscode.postMessage({type:'ready'}); return; }
    vscode.postMessage({type:'search', query:q});
  }
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { submitSearch(); }
  });

  // Click delegation
  document.addEventListener('click', function(e) {
    var el = e.target.closest('[data-action]');
    if (!el) { return; }
    var a = el.dataset.action;
    if (a === 'reindex') {
      vscode.postMessage({type:'reindex'});
    } else if (a === 'back') {
      renderResults(resultsData, isResultsMode);
      searchInput.focus();
    } else if (a === 'openSession') {
      vscode.postMessage({type:'openSession', chatId:el.dataset.id, snippet:el.dataset.snippet||''});
    } else if (a === 'copyMsg') {
      var idx = parseInt(el.dataset.idx, 10);
      var text = (currentMsgs[idx] || {}).content || '';
      vscode.postMessage({type:'copyMsg', text:text});
    } else if (a === 'openSource') {
      var matchedMsg = (currentMatchedIdx >= 0 && currentSession) ? currentSession.messages[currentMatchedIdx] : null;
      var mln = matchedMsg ? (matchedMsg.line_number || 0) : 0;
      var mc  = matchedMsg ? (matchedMsg.content || '').replace(/\\s+/g, ' ').slice(0, 80) : '';
      vscode.postMessage({type:'openSource', chatId:el.dataset.chatId, sourceType:el.dataset.sourceType, filePath:el.dataset.filepath, content:currentSnippet.slice(0,200), matchedLineNumber:mln, matchedContent:mc});
    } else if (a === 'openFile') {
      vscode.postMessage({type:'openFile', filePath:el.dataset.filepath, lineNumber:parseInt(el.dataset.line||'0',10), snippet:el.dataset.snippet||''});
    }
  });

  // Boot
  vscode.postMessage({type:'ready'});
}());
</script>
</body>
</html>`;
    }
}
