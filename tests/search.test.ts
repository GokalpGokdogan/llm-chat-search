import { SearchEngine } from '../src/search';
import type { ChatSession } from '../src/indexer';

function makeSession(id: string, title: string, texts: string[]): ChatSession {
    return {
        chat_id: id,
        chat_title: title,
        messages: texts.map((content, i) => ({
            timestamp: new Date(0),
            role: i % 2 === 0 ? 'user' : 'llm',
            chat_id: id,
            content,
            source_file: `/mock/${id}.json`,
            line_number: i,
        })),
        source_file: `/mock/${id}.json`,
        source_type: 'custom',
        total_messages: texts.length,
    };
}

describe('SearchEngine (keyword search)', () => {
    const sessions = [
        makeSession('a', 'Docker networking', ['How do I expose a port in Docker?', 'Use the -p flag.']),
        makeSession('b', 'Python lists', ['How do I reverse a list?', 'Use list.reverse().']),
    ];
    // The embedding cache path is derived from the index path and is only read if it exists.
    const engine = new SearchEngine('/nonexistent/index.json', sessions);

    it('finds the session that contains the query', async () => {
        const result = await engine.search('docker', false);
        expect(result.matches[0].id).toBe('a');
    });

    it('tolerates a small typo (fuzzy match)', async () => {
        const result = await engine.search('dockr', false);
        expect(result.matches.map(m => m.id)).toContain('a');
    });

    it('returns no matches for unrelated text', async () => {
        const result = await engine.search('kubernetes ingress', false);
        expect(result.matches).toHaveLength(0);
    });

    it('returns matches sorted by relevance, one per session', async () => {
        const result = await engine.search('how do I', false);
        const ids = result.matches.map(m => m.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (let i = 1; i < result.matches.length; i++) {
            expect(result.matches[i - 1].relevance).toBeGreaterThanOrEqual(result.matches[i].relevance);
        }
    });

    it('works with an empty session list', async () => {
        const empty = new SearchEngine('/nonexistent/index.json', []);
        const result = await empty.search('anything', false);
        expect(result.matches).toEqual([]);
    });
});
