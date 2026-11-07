# LLM Chat Search

A VS Code and Cursor extension that searches the chat history of your AI coding assistants in one place.

Your chats sit in different folders and formats. This extension reads them, builds a local index, and gives you one search box in the sidebar.

<!-- TODO (owner): add a screenshot or short GIF of the sidebar here, for example images/screenshot.png -->

## Features

- **One search for many tools.** Reads chat logs from Cursor, Continue.dev, GitHub Copilot Chat, Windsurf, Aider, and Claude Code (see [Sources](#sources)).
- **Fuzzy search.** Uses [Fuse.js](https://www.fusejs.io/), so small typos still find results.
- **Optional semantic search.** Finds related chats by meaning. It uses local [Ollama](https://ollama.com) first and OpenAI as a fallback. It is off by default and marked experimental.
- **Chat reader.** Click a result to read the full conversation in the sidebar. The matching message is highlighted.
- **Copy and open.** Copy any message. Open the source file at the matching place (file-based sources).
- **Local index.** The index is a JSON file in the extension storage folder. One index per workspace.

## Install from VSIX

Requires VS Code 1.85 or newer (or a Cursor version based on it) and Node.js 22 (the version used in CI).

```bash
git clone <repository-url>
cd llm-chat-search-extension
npm ci
npm run package
```

Then install the `.vsix` file that `vsce` creates:

```bash
code --install-extension llm-chat-search-extension-1.0.0.vsix
# or for Cursor:
cursor --install-extension llm-chat-search-extension-1.0.0.vsix
```

## Usage

1. Open the **LLM Chat Search** icon in the Activity Bar.
2. Click **↻** (or run **LLM Chat Search: Re-index All Sources** from the Command Palette) to build the index.
3. Type a query. Results show the source tool, the chat title, and a snippet.
4. Click a result to read the chat.

The command **LLM Chat Search: Search LLM Chats…** moves focus to the sidebar. The extension does not set a default keyboard shortcut.

## Sources

| Source | How it is found | Notes |
|--------|-----------------|-------|
| Continue.dev | `~/.continue/sessions/*.json` | Always scanned. |
| GitHub Copilot Chat | VS Code `workspaceStorage/*/chatSessions/*.json` | Only the current workspace when a folder is open. |
| Cursor | `state.vscdb` files in the Cursor user folder | Reads Cursor's internal SQLite keys. Only the current workspace when a folder is open. |
| Windsurf | `~/.codeium/windsurf/chat` and Windsurf `workspaceStorage` | Experimental. See [Known limits](#known-limits). |
| Claude Code | `~/.claude/projects/<workspace>/*.jsonl` | Only when a folder is open. Only that workspace. |
| Aider | Not auto-discovered | Add the folder that holds `.aider.chat.history.md` to `llmChatSearch.extraPaths`. |
| Custom | `llmChatSearch.extraPaths` | Scans `.json`, `.md`, and `.txt` files in each folder (or a single file). |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `llmChatSearch.extraPaths` | `[]` | Extra folders or files to scan. `~` is supported. |
| `llmChatSearch.maxResults` | `20` | Maximum results shown (5 to 100). |
| `llmChatSearch.semanticSearch` | `false` | Add semantic search to keyword search. |
| `llmChatSearch.autoReindex` | `false` | Re-index when the extension activates. |
| `llmChatSearch.openAiKey` | `""` | OpenAI key for embeddings. Used only if Ollama is not available. |

### Semantic search

1. **Local (no data leaves your machine):** install Ollama, run `ollama pull nomic-embed-text`, and set `llmChatSearch.semanticSearch` to `true`.
2. **OpenAI:** set `llmChatSearch.semanticSearch` to `true` and add `llmChatSearch.openAiKey`. The extension sends chat text to the OpenAI embeddings API (`text-embedding-3-small`).

The extension tries Ollama at `http://localhost:11434` first. Embeddings are cached next to the index file.

## Known limits

- The extension reads the private storage formats of other tools. These formats can change without notice. Cursor, Windsurf, and Copilot support was written against sample structures and may break with newer versions.
- Windsurf parsing reuses the Cursor SQLite reader. Windsurf `.json` chat files are probably not read. Treat Windsurf as unverified.
- Aider is not found automatically. Use `llmChatSearch.extraPaths`.
- Timestamps are missing for Continue.dev, Aider, and custom files.
- The Cursor reader uses `better-sqlite3`, a native module. A VSIX built on one OS or CPU may not load on another. Build the VSIX on the machine you install it on.
- Opening a Copilot or Continue.dev chat in its own UI is not possible through public APIs. The extension opens the source file instead.
- The index is rebuilt in full on each re-index. Very large histories can take a while.
- Not yet published on the VS Code Marketplace.

## Development

```bash
npm ci
npm run check     # type check
npm run lint
npm test          # jest unit tests
npm run compile   # bundle to dist/extension.js with esbuild
npm run watch     # rebuild on change
```

The unit tests cover the file parsers and the fuzzy search. They do not start VS Code. There are no integration tests.

## License

MIT. See [LICENSE](LICENSE).
