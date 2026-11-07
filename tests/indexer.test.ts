import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatDataIngester } from '../src/indexer';

describe('ChatDataIngester', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-chat-search-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns no sessions for an empty directory', async () => {
        const sessions = await new ChatDataIngester().ingestDirectory(dir);
        expect(sessions).toHaveLength(0);
    });

    it('returns no sessions for a path that does not exist', async () => {
        const sessions = await new ChatDataIngester().ingestDirectory(path.join(dir, 'missing'));
        expect(sessions).toHaveLength(0);
    });

    it('parses an Aider markdown history', async () => {
        const file = path.join(dir, '.aider.chat.history.md');
        fs.writeFileSync(file, [
            '#### human',
            'How do I reverse a list?',
            '',
            '#### aider',
            'Use `list.reverse()` or slicing.',
        ].join('\n'));

        const sessions = await new ChatDataIngester().ingestDirectory(dir);

        expect(sessions).toHaveLength(1);
        expect(sessions[0].source_type).toBe('aider');
        expect(sessions[0].chat_title).toBe('How do I reverse a list?');
        expect(sessions[0].messages.map(m => m.role)).toEqual(['user', 'llm']);
    });

    it('parses a Continue.dev style JSON session passed as a custom file', async () => {
        const file = path.join(dir, 'session.json');
        fs.writeFileSync(file, JSON.stringify([
            { role: 'user', content: 'Explain closures' },
            { role: 'assistant', content: [{ type: 'text', text: 'A closure keeps its scope.' }] },
        ]));

        const sessions = await new ChatDataIngester().ingestDirectory(file);

        expect(sessions).toHaveLength(1);
        expect(sessions[0].total_messages).toBe(2);
        expect(sessions[0].messages[1].content).toBe('A closure keeps its scope.');
    });

    it('skips files it cannot parse', async () => {
        fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
        const sessions = await new ChatDataIngester().ingestDirectory(dir);
        expect(sessions).toHaveLength(0);
    });

    it('saves and loads an index with Date timestamps restored', async () => {
        const ingester = new ChatDataIngester();
        fs.writeFileSync(path.join(dir, 'chat.md'), '#### human\nhello\n#### aider\nhi\n');
        const sessions = await ingester.ingestDirectory(dir);

        const indexPath = path.join(dir, 'index.json');
        await ingester.saveIndex(sessions, indexPath);
        const loaded = ingester.loadIndex(indexPath);

        expect(loaded).toHaveLength(1);
        expect(loaded[0].messages[0].timestamp).toBeInstanceOf(Date);
        expect(loaded[0].chat_id).toBe(sessions[0].chat_id);
    });

    it('returns an empty list when the index file is missing', () => {
        expect(new ChatDataIngester().loadIndex(path.join(dir, 'nope.json'))).toEqual([]);
    });
});
