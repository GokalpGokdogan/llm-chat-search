// src/indexer.ts

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { glob } from 'glob';
import Database from 'better-sqlite3';


// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMessage {
    timestamp: Date;
    role: 'user' | 'llm' | 'system';
    chat_id: string;
    content: string;
    source_file: string;
    line_number: number;
}

interface ChatSession {
    chat_id: string;
    chat_title: string;
    messages: ChatMessage[];
    source_file: string;
    source_type: SourceType;
    total_messages: number;
}

type SourceType = 'cursor' | 'continue' | 'windsurf' | 'copilot' | 'aider' | 'custom' | 'claudecode';

interface SourceDefinition {
    id: SourceType;
    label: string;
    globs: string[];
    extensions: string[];
}

const HOME = os.homedir();

const KNOWN_SOURCES: SourceDefinition[] = [
    {
        id: 'continue',
        label: 'Continue.dev',
        globs: [
            path.join(HOME, '.continue', 'sessions', '*.json'),
            path.join(HOME, '.continue', 'sessions', '**', '*.json'),
        ],
        extensions: ['.json'],
    },
    {
        id: 'copilot',
        label: 'GitHub Copilot Chat',
        globs: [
            path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage', '**', 'chatSessions', '*.json'),
            path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage', '**', 'chatSessions', '*.json'),
            path.join(HOME, '.config', 'Code', 'User', 'workspaceStorage', '**', 'chatSessions', '*.json'),
        ],
        extensions: ['.json'],
    },
    {
        id: 'cursor',
        label: 'Cursor',
        globs: [
            path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage', '**', 'state.vscdb'),
            path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
            path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage', '**', 'state.vscdb'),
            path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
            path.join(HOME, '.config', 'Cursor', 'User', 'workspaceStorage', '**', 'state.vscdb'),
        ],
        extensions: ['.vscdb'],
    },
    {
        id: 'windsurf',
        label: 'Windsurf',
        globs: [
            path.join(HOME, '.codeium', 'windsurf', 'chat', '**', '*.json'),
            path.join(HOME, 'Library', 'Application Support', 'Windsurf', 'User', 'workspaceStorage', '**', 'chat*.json'),
            path.join(HOME, 'AppData', 'Roaming', 'Windsurf', 'User', 'workspaceStorage', '**', 'chat*.json'),
        ],
        extensions: ['.json'],
    },
];

// ─── Per-source parsers ───────────────────────────────────────────────────────

function generateId(base: string): string {
    return Buffer.from(base).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}


/**
 * Continue.dev: { sessionId, title, history: [{ message: { role, content } }] }
 * content is either a string OR an array of { type: 'text', text: '...' }
 */
function parseContinueFile(filePath: string): ChatSession[] {
    // Skip the sessions.json index file (it has no actual messages)
    if (path.basename(filePath) === 'sessions.json') return [];

    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        const chatId = data.sessionId ?? path.basename(filePath, '.json');
        // Also accept a bare array of { role, content } messages (used for custom paths).
        const history: any[] = Array.isArray(data)
            ? data.map((message: any) => ({ message }))
            : Array.isArray(data.history) ? data.history : [];

        const messages: ChatMessage[] = history
            .map((h: any) => h.message)
            .filter((m: any) => m && m.role && m.content)
            .map((m: any, i: number): ChatMessage => ({
                timestamp: new Date(0),
                role: normalizeRole(m.role),
                chat_id: chatId,
                content: extractTextContent(m.content),
                source_file: filePath,
                line_number: i,
            }))
            .filter((m: ChatMessage) => m.content.trim().length > 0);

        if (messages.length === 0) return [];

        return [{
            chat_id: chatId,
            chat_title: data.title || chatId,
            messages,
            source_file: filePath,
            source_type: 'continue',
            total_messages: messages.length,
        }];
    } catch {
        return [];
    }
}

/**
 * GitHub Copilot Chat (VS Code workspaceStorage):
 * { version, requests: [{ requestId, message: { text }, response: [{ kind, content }] }] }
 */
function parseCopilotFile(filePath: string): ChatSession[] {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        const requests: any[] = Array.isArray(data.requests) ? data.requests : [];
        if (requests.length === 0) return [];

        const chatId = path.basename(filePath, '.json');
        const messages: ChatMessage[] = [];

        requests.forEach((req: any, i: number) => {
            // User message
            const userText = req.message?.text ?? extractTextContent(req.message);
            if (userText && userText.trim()) {
                messages.push({
                    timestamp: req.timestamp ? new Date(req.timestamp) : new Date(0),
                    role: 'user',
                    chat_id: chatId,
                    content: userText,
                    source_file: filePath,
                    line_number: i * 2,
                });
            }

            // Assistant response: array of parts with { kind, content }
            const responseParts: any[] = Array.isArray(req.response) ? req.response : [];
            const assistantText = responseParts
                .map((p: any) => {
                    if (typeof p?.content === 'string') return p.content;
                    if (p?.content?.value) return p.content.value;
                    if (typeof p?.value === 'string') return p.value;
                    return '';
                })
                .filter(Boolean)
                .join('\n');

            if (assistantText.trim()) {
                messages.push({
                    timestamp: req.timestamp ? new Date(req.timestamp) : new Date(0),
                    role: 'llm',
                    chat_id: chatId,
                    content: assistantText,
                    source_file: filePath,
                    line_number: i * 2 + 1,
                });
            }
        });

        if (messages.length === 0) return [];

        const firstUser = messages.find(m => m.role === 'user');
        const title = firstUser
            ? firstUser.content.split('\n')[0].slice(0, 60)
            : chatId;

        return [{
            chat_id: chatId,
            chat_title: title,
            messages,
            source_file: filePath,
            source_type: 'copilot',
            total_messages: messages.length,
        }];
    } catch {
        return [];
    }
}

/**
 * Cursor: SQLite database. Chat data stored under keys:
 *   - workbench.panel.aichat.view.aichat.chatdata  (chat panel)
 *   - composer.composerData                         (composer)
 *   - aiService.prompts                             (prompt history)
 */
function parseCursorFile(filePath: string): ChatSession[] {
    const sessions: ChatSession[] = [];

    let db: Database.Database;
    try {
        db = new Database(filePath, { readonly: true, fileMustExist: true });
    } catch {
        return [];
    }

    const readKey = (key: string): any => {
        try {
            const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value: string } | undefined;
            if (!row?.value) return null;
            return JSON.parse(row.value);
        } catch {
            return null;
        }
    };

    try {
        // ─── Chat panel data ───────────────────────────────────────
        const chatData = readKey('workbench.panel.aichat.view.aichat.chatdata');
        const tabs: any[] = chatData?.tabs ?? [];

        for (const tab of tabs) {
            const chatId = tab.tabId ?? tab.id ?? generateId(filePath + tab.chatTitle);
            const title = tab.chatTitle ?? tab.title ?? 'Cursor Chat';
            const bubbles: any[] = tab.bubbles ?? [];

            const messages: ChatMessage[] = bubbles
                .filter((b: any) => b.type && (b.text || b.content))
                .map((b: any, i: number): ChatMessage => ({
                    timestamp: b.timestamp ? new Date(b.timestamp) : new Date(0),
                    role: b.type === 'user' ? 'user' : 'llm',
                    chat_id: chatId,
                    content: extractTextContent(b.text ?? b.content),
                    source_file: filePath,
                    line_number: i,
                }))
                .filter((m: ChatMessage) => m.content.trim().length > 0);

            if (messages.length === 0) continue;

            sessions.push({
                chat_id: chatId,
                chat_title: title,
                messages,
                source_file: filePath,
                source_type: 'cursor',
                total_messages: messages.length,
            });
        }

        // ─── Composer data ─────────────────────────────────────────
        const composerData = readKey('composer.composerData');
        const composers: any[] = composerData?.allComposers ?? [];

        for (const comp of composers) {
            const chatId = comp.composerId ?? generateId(filePath + (comp.name ?? ''));
            const title = comp.name ?? 'Cursor Composer';
            const convo: any[] = comp.conversation ?? [];

            const messages: ChatMessage[] = convo
                .filter((m: any) => m.type !== undefined && (m.text || m.content))
                .map((m: any, i: number): ChatMessage => ({
                    timestamp: m.timestamp ? new Date(m.timestamp) : new Date(0),
                    role: m.type === 1 || m.type === 'user' ? 'user' : 'llm',
                    chat_id: chatId,
                    content: extractTextContent(m.text ?? m.content),
                    source_file: filePath,
                    line_number: i,
                }))
                .filter((m: ChatMessage) => m.content.trim().length > 0);

            if (messages.length === 0) continue;

            sessions.push({
                chat_id: chatId,
                chat_title: title,
                messages,
                source_file: filePath,
                source_type: 'cursor',
                total_messages: messages.length,
            });
        }
    } finally {
        db.close();
    }

    return sessions;
}

/**
 * Windsurf: Same shape as Cursor.
 */
function parseWindsurfFile(filePath: string): ChatSession[] {
    const sessions = parseCursorFile(filePath);
    return sessions.map(s => ({ ...s, source_type: 'windsurf' as SourceType }));
}


/**
 * Aider: Markdown with #### human / #### aider headers.
 */
function parseAiderFile(filePath: string): ChatSession[] {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n');
        const chatId = generateId(filePath);
        const messages: ChatMessage[] = [];

        let currentRole: 'user' | 'llm' | 'system' | null = null;
        let currentLines: string[] = [];
        let lineNum = 0;
        let startLine = 0;

        const flush = () => {
            const content = currentLines.join('\n').trim();
            if (currentRole && content) {
                messages.push({
                    timestamp: new Date(0),
                    role: currentRole,
                    chat_id: chatId,
                    content,
                    source_file: filePath,
                    line_number: startLine,
                });
            }
            currentLines = [];
        };

        for (const line of lines) {
            if (line.startsWith('#### human') || line.startsWith('#### Human')) {
                flush();
                currentRole = 'user';
                startLine = lineNum;
            } else if (line.startsWith('#### aider') || line.startsWith('#### Aider')) {
                flush();
                currentRole = 'llm';
                startLine = lineNum;
            } else {
                currentLines.push(line);
            }
            lineNum++;
        }
        flush();

        if (messages.length === 0) return [];

        const firstUser = messages.find(m => m.role === 'user');
        const title = firstUser
            ? firstUser.content.split('\n')[0].slice(0, 60)
            : path.basename(filePath);

        return [{
            chat_id: chatId,
            chat_title: title || chatId,
            messages,
            source_file: filePath,
            source_type: 'aider',
            total_messages: messages.length,
        }];
    } catch {
        return [];
    }
}

/**
 * Claude Code: JSONL files at ~/.claude/projects/<project-key>/<sessionId>.jsonl
 * Each line is {"type":"user"|"assistant", "message":{"content":...}, "timestamp":"...", "sessionId":"..."}
 */
function parseClaudeCodeFile(filePath: string): ChatSession[] {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n').filter(l => l.trim());

        let sessionId: string | undefined;
        const messages: ChatMessage[] = [];

        for (let i = 0; i < lines.length; i++) {
            try {
                const entry = JSON.parse(lines[i]);
                if (!sessionId && entry.sessionId) { sessionId = entry.sessionId; }
                if (entry.type !== 'user' && entry.type !== 'assistant') { continue; }
                if (!entry.message) { continue; }

                const role: 'user' | 'llm' = entry.type === 'user' ? 'user' : 'llm';
                const content = extractTextContent(entry.message.content ?? '');
                if (!content.trim()) { continue; }

                messages.push({
                    timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(0),
                    role,
                    chat_id: sessionId ?? path.basename(filePath, '.jsonl'),
                    content,
                    source_file: filePath,
                    line_number: i,
                });
            } catch { /* skip malformed lines */ }
        }

        if (messages.length === 0) { return []; }

        const chatId = sessionId ?? generateId(filePath);
        const firstUser = messages.find(m => m.role === 'user');
        const rawTitle = firstUser
            ? firstUser.content.replace(/<[^>]*>[\s\S]*?<\/[^>]+>/g, '').replace(/<[^>]*>/g, '').split('\n').find(l => l.trim()) ?? ''
            : '';
        const title = rawTitle.trim().slice(0, 60) || path.basename(filePath, '.jsonl');

        return [{
            chat_id: chatId,
            chat_title: title,
            messages,
            source_file: filePath,
            source_type: 'claudecode',
            total_messages: messages.length,
        }];
    } catch {
        return [];
    }
}

/**
 * Given a file inside a workspaceStorage/<hash>/ directory, resolve which workspace
 * it belongs to by reading workspace.json in the hash directory.
 * Returns the decoded workspace path, or null if not found.
 */
function workspaceForStorageFile(filePath: string): string | null {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 3; i++) {
        const wsJsonPath = path.join(dir, 'workspace.json');
        try {
            const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf-8'));
            const folderUri: string = wsJson.folder ?? wsJson.workspace ?? '';
            if (folderUri) {
                return decodeURIComponent(folderUri.replace(/^file:\/\//, ''));
            }
        } catch { /* not found at this level */ }
        const parent = path.dirname(dir);
        if (parent === dir) { break; }
        dir = parent;
    }
    return null;
}

function normalizePath(p: string): string {
    return path.normalize(p).replace(/[/\\]+$/, '');
}

/**
 * Generic parser for unknown JSON/markdown under custom paths.
 */
function parseCustomFile(filePath: string): ChatSession[] {
    const ext = path.extname(filePath).toLowerCase();
    try {
        if (ext === '.json') {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (Array.isArray(data) && data[0]?.role) return parseContinueFile(filePath);
            if (data.messages || data.tabs || data.chat) return parseCursorFile(filePath);
            if (data.conversations || (Array.isArray(data) && data[0]?.turns)) return parseCopilotFile(filePath);
        }
        if (ext === '.md' || ext === '.txt') {
            return parseAiderFile(filePath);
        }
    } catch { /* skip unparseable files */ }
    return [];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeRole(raw: string): 'user' | 'llm' | 'system' {
    const r = (raw ?? '').toLowerCase();
    if (r === 'user' || r === 'human') return 'user';
    if (r === 'assistant' || r === 'llm' || r === 'aider' || r === 'bot' || r === 'copilot') return 'llm';
    return 'system';
}

function extractTextContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map(part => (typeof part === 'string' ? part : part?.text ?? part?.content ?? ''))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof content === 'object' && content !== null) {
        return content.text ?? content.content ?? JSON.stringify(content);
    }
    return String(content ?? '');
}

// ─── Main ingester class ──────────────────────────────────────────────────────

class ChatDataIngester {
    parsed_data: ChatSession[] = [];
    private discoveredSources: Map<SourceType, string[]> = new Map();

    async ingestAll(extraPaths: string[] = [], workspacePath?: string): Promise<ChatSession[]> {
        const allSessions: ChatSession[] = [];

        for (const source of KNOWN_SOURCES) {
            const sessions = await this.ingestSource(source, workspacePath);
            allSessions.push(...sessions);
        }

        // Claude Code: only index the project directory matching the current workspace
        if (workspacePath) {
            const claudeSessions = await this.ingestClaudeCode(workspacePath);
            allSessions.push(...claudeSessions);
        }

        for (const rawPath of extraPaths) {
            const resolved = rawPath.replace(/^~/, HOME);
            const sessions = await this.ingestCustomPath(resolved);
            allSessions.push(...sessions);
        }

        this.parsed_data = allSessions;
        return allSessions;
    }

    async ingestDirectory(logDirectoryPath: string): Promise<ChatSession[]> {
        const resolved = logDirectoryPath.replace(/^~/, HOME);
        if (!logDirectoryPath || logDirectoryPath === HOME || logDirectoryPath === '~') {
            return this.ingestAll();
        }
        const sessions = await this.ingestCustomPath(resolved);
        this.parsed_data = sessions;
        return sessions;
    }

    async saveIndex(sessions: ChatSession[], indexPath: string): Promise<void> {
        const serializable = sessions.map(s => ({
            ...s,
            messages: s.messages.map(m => ({
                ...m,
                timestamp: m.timestamp.toISOString(),
            })),
        }));
        fs.writeFileSync(indexPath, JSON.stringify(serializable, null, 2), 'utf-8');
        console.log(`Index saved: ${sessions.length} sessions → ${indexPath}`);
    }

    loadIndex(indexPath: string): ChatSession[] {
        if (!fs.existsSync(indexPath)) return [];
        try {
            const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            return raw.map((s: any) => ({
                ...s,
                messages: s.messages.map((m: any) => ({
                    ...m,
                    timestamp: new Date(m.timestamp),
                })),
            }));
        } catch {
            return [];
        }
    }

    getDiscoveryReport(): Record<string, number> {
        const report: Record<string, number> = {};
        this.discoveredSources.forEach((files, source) => {
            report[source] = files.length;
        });
        return report;
    }

    private async ingestSource(source: SourceDefinition, workspacePath?: string): Promise<ChatSession[]> {
        const sessions: ChatSession[] = [];
        const foundFiles: string[] = [];

        for (const pattern of source.globs) {
            try {
                const files = await glob(pattern, { absolute: true, nodir: true });
                foundFiles.push(...files);
            } catch {
                // Pattern not valid on this OS, skip
            }
        }

        const uniqueFiles = [...new Set(foundFiles)].filter(f =>
            source.extensions.includes(path.extname(f).toLowerCase())
        );

        this.discoveredSources.set(source.id, uniqueFiles);

        if (uniqueFiles.length > 0) {
            console.log(`[${source.label}] Found ${uniqueFiles.length} file(s)`);
        }

        const isWorkspaceSource = source.id === 'cursor' || source.id === 'windsurf' || source.id === 'copilot';

        for (const file of uniqueFiles) {
            // When a workspace is active, filter workspaceStorage-based sources to only that workspace
            if (workspacePath && isWorkspaceSource) {
                const fileWs = workspaceForStorageFile(file);
                if (fileWs && normalizePath(fileWs) !== normalizePath(workspacePath)) {
                    continue;
                }
            }
            const parsed = this.parseFile(file, source.id);
            sessions.push(...parsed);
        }

        return sessions;
    }

    private async ingestClaudeCode(workspacePath: string): Promise<ChatSession[]> {
        // Project key: replace all non-alphanumeric chars with '-'
        const key = workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
        const projectDir = path.join(HOME, '.claude', 'projects', key);

        if (!fs.existsSync(projectDir)) { return []; }

        const files = (await glob(path.join(projectDir, '*.jsonl'), { absolute: true, nodir: true }));
        if (files.length === 0) { return []; }

        this.discoveredSources.set('claudecode', files);
        console.log(`[Claude Code] Found ${files.length} conversation(s) in ${projectDir}`);

        const sessions: ChatSession[] = [];
        for (const file of files) {
            sessions.push(...parseClaudeCodeFile(file));
        }
        return sessions;
    }

    private async ingestCustomPath(dirPath: string): Promise<ChatSession[]> {
        const sessions: ChatSession[] = [];

        if (!fs.existsSync(dirPath)) {
            console.warn(`Custom path does not exist: ${dirPath}`);
            return [];
        }

        const stat = fs.statSync(dirPath);
        const files: string[] = [];

        if (stat.isFile()) {
            files.push(dirPath);
        } else {
            const found = await glob(path.join(dirPath, '**', '*.{json,md,txt}'), {
                absolute: true,
                nodir: true,
                dot: true, // Aider writes a dotfile: .aider.chat.history.md
                ignore: ['**/node_modules/**', '**/.git/**'],
            });
            files.push(...found);
        }

        console.log(`[Custom] Found ${files.length} file(s) in ${dirPath}`);

        for (const file of files) {
            const parsed = parseCustomFile(file);
            sessions.push(...parsed);
        }

        return sessions;
    }

    private parseFile(filePath: string, sourceType: SourceType): ChatSession[] {
        switch (sourceType) {
            case 'cursor':      return parseCursorFile(filePath);
            case 'continue':    return parseContinueFile(filePath);
            case 'windsurf':    return parseWindsurfFile(filePath);
            case 'copilot':     return parseCopilotFile(filePath);
            case 'aider':       return parseAiderFile(filePath);
            case 'claudecode':  return parseClaudeCodeFile(filePath);
            default:            return parseCustomFile(filePath);
        }
    }
}

export { ChatDataIngester, type ChatSession, type ChatMessage, type SourceType };
