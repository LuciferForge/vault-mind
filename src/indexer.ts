/**
 * indexer.ts — Vault crawler with incremental update support
 *
 * Strategy:
 * 1. Scan all .md files in the vault, collect paths + mtimes
 * 2. Compare against stored metadata — only process changed/new files
 * 3. Remove stale entries for deleted files
 * 4. Embed in configurable batches, yielding between batches to stay responsive
 * 5. Save to disk only after full batch completes (not per-file — saves I/O)
 *
 * The yield pattern (setTimeout 0) releases the JS thread between batches,
 * preventing Obsidian's UI from freezing on large vaults.
 */

import { App, TFile } from "obsidian";
import { OllamaEmbedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { IndexProgress } from "./types";

export class Indexer {
  private app: App;
  private embedder: OllamaEmbedder;
  private store: VectorStore;
  private chunkSize: number;
  private abortFlag = false;

  constructor(
    app: App,
    embedder: OllamaEmbedder,
    store: VectorStore,
    chunkSize: number
  ) {
    this.app = app;
    this.embedder = embedder;
    this.store = store;
    this.chunkSize = chunkSize;
  }

  /** Signal a running index to stop gracefully at the next chunk boundary */
  abort(): void {
    this.abortFlag = true;
  }

  /**
   * Run incremental indexing.
   * onProgress is called after each file is processed.
   * Resolves when indexing is complete or aborted.
   */
  async indexVault(
    onProgress: (progress: IndexProgress) => void,
    fullReindex = false
  ): Promise<void> {
    this.abortFlag = false;

    // --- Phase 1: Scan vault ---
    onProgress({ indexed: 0, total: 0, currentFile: "", phase: "scanning" });

    const allMdFiles = this.app.vault.getMarkdownFiles();
    const total = allMdFiles.length;

    if (total === 0) {
      onProgress({ indexed: 0, total: 0, currentFile: "", phase: "done" });
      return;
    }

    if (fullReindex) {
      this.store.clear();
    }

    // Identify which files actually need embedding
    const toIndex: TFile[] = [];
    const currentPaths = new Set<string>();

    for (const file of allMdFiles) {
      currentPaths.add(file.path);
      const mtime = file.stat.mtime;
      if (!this.store.isUpToDate(file.path, mtime)) {
        toIndex.push(file);
      }
    }

    // Remove metadata for files that no longer exist
    const storedMeta = this.store.getAllMetadata();
    for (const meta of storedMeta) {
      if (!currentPaths.has(meta.path)) {
        this.store.removeEmbedding(meta.path);
      }
    }

    if (toIndex.length === 0) {
      onProgress({ indexed: total, total, currentFile: "", phase: "done" });
      await this.store.save();
      return;
    }

    // --- Phase 2: Embed in chunks ---
    let indexed = 0;

    for (let chunkStart = 0; chunkStart < toIndex.length; chunkStart += this.chunkSize) {
      if (this.abortFlag) break;

      const chunk = toIndex.slice(chunkStart, chunkStart + this.chunkSize);

      for (const file of chunk) {
        if (this.abortFlag) break;

        onProgress({
          indexed,
          total: toIndex.length,
          currentFile: file.basename,
          phase: "embedding",
        });

        try {
          const content = await this.app.vault.cachedRead(file);
          const text = this.prepareText(file.basename, content);
          const embedding = await this.embedder.embed(text);
          const snippet = this.extractSnippet(content);

          this.store.addEmbedding(
            file.path,
            embedding,
            file.stat.mtime,
            file.basename,
            snippet
          );
        } catch (e: unknown) {
          // Don't abort the entire index for one bad file — log and continue
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[VaultMind] Failed to embed "${file.path}": ${msg}`);
          onProgress({
            indexed,
            total: toIndex.length,
            currentFile: file.basename,
            phase: "error",
            error: msg,
          });
          // Propagate Ollama connectivity errors — no point grinding through 1000 files if Ollama is down
          if (msg.includes("Cannot reach Ollama") || msg.includes("HTTP 5")) {
            throw e;
          }
        }

        indexed++;
      }

      // Yield thread between chunks — keeps Obsidian UI responsive
      await yieldThread();
    }

    // --- Phase 3: Save ---
    if (!this.abortFlag) {
      onProgress({
        indexed: toIndex.length,
        total: toIndex.length,
        currentFile: "",
        phase: "saving",
      });
      await this.store.save();
      onProgress({
        indexed: toIndex.length,
        total: toIndex.length,
        currentFile: "",
        phase: "done",
      });
    }
  }

  /**
   * Index or update a single file — called from file change watchers.
   * Does not save; caller should debounce and call store.save() separately.
   */
  async indexFile(file: TFile): Promise<void> {
    try {
      const content = await this.app.vault.cachedRead(file);
      const text = this.prepareText(file.basename, content);
      const embedding = await this.embedder.embed(text);
      const snippet = this.extractSnippet(content);

      this.store.addEmbedding(
        file.path,
        embedding,
        file.stat.mtime,
        file.basename,
        snippet
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[VaultMind] Failed to index "${file.path}": ${msg}`);
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Prepare note text for embedding.
   * Prepend the title so semantic search weights it appropriately.
   * Strip Markdown syntax that adds noise without semantic value.
   * Truncate to ~4000 chars — nomic-embed-text has 8k context but we pay per token in latency.
   */
  private prepareText(title: string, content: string): string {
    const cleaned = content
      .replace(/^---[\s\S]*?---\n/, "") // strip YAML frontmatter
      .replace(/!\[.*?\]\(.*?\)/g, "")  // strip image embeds
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1") // [[link|alias]] → link text
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1") // [text](url) → text
      .replace(/#{1,6}\s/g, "")          // strip heading markers
      .replace(/[*_`~]/g, "")            // strip bold/italic/code markers
      .replace(/\n{3,}/g, "\n\n")        // collapse excessive blank lines
      .trim();

    const combined = `${title}\n\n${cleaned}`;
    return combined.slice(0, 4000);
  }

  /** Extract a short preview snippet — first meaningful paragraph, max 200 chars */
  private extractSnippet(content: string): string {
    const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n/, "");
    const lines = withoutFrontmatter.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip blank lines and heading-only lines
      if (trimmed.length > 20 && !trimmed.startsWith("#")) {
        return trimmed.slice(0, 200);
      }
    }
    // Fallback — just take the first 200 chars
    return withoutFrontmatter.slice(0, 200).trim();
  }
}

/** Release JS thread for one event loop tick */
function yieldThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
