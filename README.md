# Vault Mind

Local AI-powered semantic search for Obsidian. Your notes never leave your machine.

## What it does

Vault Mind lets you search your vault by meaning, not keywords. Ask "what did I write about productivity?" and it finds relevant notes even if none of them contain those exact words.

All embeddings run locally via [Ollama](https://ollama.com). No API keys. No cloud. No data leaves your machine.

## Requirements

- [Obsidian](https://obsidian.md) 1.0.0+
- [Ollama](https://ollama.com) running locally
- The `nomic-embed-text` model (or any other Ollama embedding model)

## Setup

### 1. Install Ollama

Download from [ollama.com](https://ollama.com) and run:

```bash
ollama serve
```

### 2. Pull the embedding model

```bash
ollama pull nomic-embed-text
```

This is a ~274MB download. It runs on CPU — no GPU required.

### 3. Install Vault Mind

Until this plugin is in the community marketplace:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/LuciferForge/vault-mind/releases)
2. Create a folder: `<your-vault>/.obsidian/plugins/vault-mind/`
3. Place the three files in that folder
4. Enable the plugin in Obsidian Settings > Community Plugins

### 4. Index your vault

Click the brain icon in the left ribbon, or run the command **Vault Mind: Update index (incremental)**.

The first index takes time — roughly 1-2 seconds per note depending on your hardware. Subsequent runs only process changed files.

## Usage

Click the brain icon (or use the ribbon) to open the search panel. Type anything — questions, concepts, partial phrases. Results update as you type with a 300ms debounce.

Each result shows:
- Similarity score (0-100%)
- Note title
- Relevant snippet with matched terms highlighted
- Click to open the note

## Settings

| Setting | Default | Description |
|---|---|---|
| Ollama endpoint | `http://localhost:11434` | URL of your Ollama server |
| Embedding model | `nomic-embed-text` | Model for generating embeddings |
| Max results | 10 | Results to show per search |
| Auto-index on startup | On | Check for changed files on load |
| Batch size | 10 | Files per indexing batch |

## How it works

1. **Indexing**: Each note is converted to a 768-dimensional vector using `nomic-embed-text`. Vectors are stored in a binary file (`.obsidian/plugins/vault-mind/data/vault-mind.bin`) alongside a JSON metadata index.

2. **Search**: Your query is embedded with the same model, then compared to all note vectors using cosine similarity. The top-k matches are returned in milliseconds.

3. **Incremental updates**: File modification times are tracked. Only changed notes are re-embedded on subsequent index runs. File watchers update individual notes 3 seconds after you stop editing.

## Storage

Index files are stored at:
```
<vault>/.obsidian/plugins/vault-mind/data/
├── vault-mind.bin         # Float32Array binary (4 bytes × 768 dims × N notes)
└── vault-mind-index.json  # Note metadata (paths, mtimes, snippets)
```

For 10,000 notes: ~30MB binary + ~5MB JSON. For 20,000 notes: ~61MB binary.

## Model recommendations

| Model | Dimensions | Size | Notes |
|---|---|---|---|
| `nomic-embed-text` | 768 | 274MB | Default. Best balance of speed and quality. |
| `mxbai-embed-large` | 1024 | 670MB | Higher quality, slower, larger index. |
| `all-minilm` | 384 | 46MB | Fastest, smallest. Good for low-RAM machines. |

If you change models, run **Re-index vault (full rebuild)** from settings or the command palette.

## Commands

- `Vault Mind: Open semantic search` — Open the search panel
- `Vault Mind: Update index (incremental)` — Embed new/changed notes
- `Vault Mind: Re-index vault (full rebuild)` — Wipe and rebuild the entire index

## Privacy

Nothing leaves your machine. Vault Mind communicates only with your local Ollama process at `localhost:11434`. No telemetry, no analytics, no network requests to external servers.

## License

MIT
