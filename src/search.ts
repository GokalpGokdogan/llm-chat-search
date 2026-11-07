// src/search.ts

import Fuse from 'fuse.js';
import * as fs from 'fs';
import type { ChatSession } from './indexer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchMatch {
    id: string;
    content: string;
    relevance: number;
}

interface SearchResult {
    sessions: ChatSession[];
    matches: SearchMatch[];
}

interface EmbeddingCache {
    version: number;
    entries: Record<string, number[]>; // chat_id → embedding vector
}

const EMBEDDING_CACHE_VERSION = 1;

// ─── Embedding providers ──────────────────────────────────────────────────────

/**
 * Tries Ollama first (local, free), falls back to OpenAI if a key is configured.
 */
async function getEmbedding(text: string, openAiKey?: string): Promise<number[] | null> {
    // Truncate to avoid token limits — most embedding models cap at ~8k tokens
    const truncated = text.slice(0, 6000);

    // ── Option A: Local Ollama ──────────────────────────────────────────────
    try {
        const res = await fetch('http://localhost:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'nomic-embed-text', prompt: truncated }),
            signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
            const data = await res.json() as { embedding: number[] };
            if (data.embedding?.length) return data.embedding;
        }
    } catch {
        // Ollama not running — fall through to OpenAI
    }

    // ── Option B: OpenAI ───────────────────────────────────────────────────
    if (openAiKey) {
        try {
            const res = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openAiKey}`,
                },
                body: JSON.stringify({ model: 'text-embedding-3-small', input: truncated }),
                signal: AbortSignal.timeout(10000),
            });
            if (res.ok) {
                const data = await res.json() as { data: { embedding: number[] }[] };
                if (data.data?.[0]?.embedding?.length) return data.data[0].embedding;
            }
        } catch {
            // OpenAI unreachable
        }
    }

    return null;
}

/**
 * Cosine similarity between two equal-length vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

// ─── SearchEngine ─────────────────────────────────────────────────────────────

class SearchEngine {
    private fuse!: Fuse<{ session: ChatSession; content: string }>;
    private allSessions: ChatSession[];
    private indexPath: string;
    private embeddingCachePath: string;
    private embeddingCache: EmbeddingCache;
    private sessionContents: Map<string, string> = new Map(); // chat_id → full text

    constructor(indexPath: string, initialSessions: ChatSession[]) {
        this.indexPath = indexPath;
        this.embeddingCachePath = indexPath.replace('.json', '-embeddings.json');
        this.allSessions = initialSessions;
        this.embeddingCache = this.loadEmbeddingCache();
        this.buildIndex(initialSessions);
    }

    private buildIndex(sessions: ChatSession[]): void {
        const documents = sessions.map(session => {
            const content = `${session.chat_title}\n${session.messages
                .map(m => `${m.role}: ${m.content}`)
                .join('\n')}`;
            this.sessionContents.set(session.chat_id, content);
            return { session, content };
        });

        this.fuse = new Fuse(documents, {
            keys: ['content'],
            includeScore: true,
            includeMatches: true,
            threshold: 0.4,
            ignoreLocation: true,
            minMatchCharLength: 3,
        });
    }

    /**
     * Search across all indexed sessions.
     *
     * @param query       - User's search string.
     * @param useSemantic - When true, also runs embedding-based semantic pass.
     * @param openAiKey   - Optional OpenAI API key (used only if Ollama is unavailable).
     */
    async search(query: string, useSemantic: boolean, openAiKey?: string): Promise<SearchResult> {
        // ── 1. Keyword / fuzzy search ────────────────────────────────────────
        const fuseResults = this.fuse.search(query);

        const keywordMatches: SearchMatch[] = fuseResults.map(result => {
            const relevance = result.score !== undefined ? 1 - result.score : 0.5;
            const snippet = this.extractSnippet(result.item.content, query);
            return { id: result.item.session.chat_id, content: snippet, relevance };
        });

        // ── 2. Semantic search ───────────────────────────────────────────────
        const semanticMatches: SearchMatch[] = [];

        if (useSemantic) {
            const queryEmbedding = await getEmbedding(query, openAiKey);

            if (queryEmbedding) {
                // Embed any sessions not yet in cache
                await this.ensureEmbeddings(openAiKey);

                for (const session of this.allSessions) {
                    const sessionEmbedding = this.embeddingCache.entries[session.chat_id];
                    if (!sessionEmbedding) continue;

                    const similarity = cosineSimilarity(queryEmbedding, sessionEmbedding);
                    if (similarity > 0.3) { // threshold — lower = broader results
                        const content = this.sessionContents.get(session.chat_id) ?? '';
                        semanticMatches.push({
                            id: session.chat_id,
                            content: this.extractSnippet(content, query),
                            relevance: similarity,
                        });
                    }
                }
            } else {
                console.warn('[semantic] No embedding provider available. Install Ollama (ollama pull nomic-embed-text) or set an OpenAI API key.');
            }
        }

        // ── 3. Merge, deduplicate, rank ──────────────────────────────────────
        const merged = this.mergeAndRank([...keywordMatches, ...semanticMatches]);

        return { sessions: this.allSessions, matches: merged };
    }

    /**
     * Pre-embeds all sessions that aren't already in the cache.
     * Saves cache to disk after each new embedding to be crash-safe.
     */
    async ensureEmbeddings(openAiKey?: string): Promise<void> {
        let dirty = false;

        for (const session of this.allSessions) {
            if (this.embeddingCache.entries[session.chat_id]) continue;

            const content = this.sessionContents.get(session.chat_id) ?? '';
            const embedding = await getEmbedding(content, openAiKey);
            if (embedding) {
                this.embeddingCache.entries[session.chat_id] = embedding;
                dirty = true;
            }
        }

        if (dirty) this.saveEmbeddingCache();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private extractSnippet(content: string, query: string): string {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const lower = content.toLowerCase();
        let bestIdx = Infinity;

        for (const word of words) {
            const idx = lower.indexOf(word);
            if (idx !== -1 && idx < bestIdx) bestIdx = idx;
        }

        if (bestIdx === Infinity) return content.slice(0, 200);

        const start = Math.max(0, bestIdx - 60);
        const end = Math.min(content.length, bestIdx + 160);
        const snippet = content.slice(start, end);
        return (start > 0 ? '…' : '') + snippet + (end < content.length ? '…' : '');
    }

    private mergeAndRank(matches: SearchMatch[]): SearchMatch[] {
        const best = new Map<string, SearchMatch>();
        for (const match of matches) {
            const existing = best.get(match.id);
            if (!existing || match.relevance > existing.relevance) {
                best.set(match.id, match);
            }
        }
        return [...best.values()].sort((a, b) => b.relevance - a.relevance);
    }

    private loadEmbeddingCache(): EmbeddingCache {
        try {
            if (fs.existsSync(this.embeddingCachePath)) {
                const raw = JSON.parse(fs.readFileSync(this.embeddingCachePath, 'utf-8'));
                if (raw.version === EMBEDDING_CACHE_VERSION) return raw;
            }
        } catch { /* cache corrupted, start fresh */ }
        return { version: EMBEDDING_CACHE_VERSION, entries: {} };
    }

    private saveEmbeddingCache(): void {
        try {
            fs.writeFileSync(this.embeddingCachePath, JSON.stringify(this.embeddingCache), 'utf-8');
        } catch (err) {
            console.error('[semantic] Failed to save embedding cache:', err);
        }
    }
}

export { SearchEngine, type SearchMatch, type SearchResult };
