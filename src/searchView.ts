/**
 * searchView.ts — Obsidian ItemView for the semantic search panel
 *
 * Registered as a leaf view in the right sidebar.
 * Design goals: feel native to Obsidian, not like a bolted-on web app.
 * Minimal DOM manipulation — build once, update in place on search.
 */

import { ItemView, WorkspaceLeaf, TFile, MarkdownView } from "obsidian";
import { SearchEngine } from "./searchEngine";
import { VectorStore } from "./vectorStore";
import { Indexer } from "./indexer";
import { SearchResult, IndexProgress, VaultMindSettings } from "./types";

export const VIEW_TYPE_VAULT_MIND = "vault-mind-search";

export class VaultMindView extends ItemView {
  private searchEngine: SearchEngine;
  private store: VectorStore;
  private indexer: Indexer;
  private settings: VaultMindSettings;
  private getSettings: () => VaultMindSettings;

  // DOM elements we need to update
  private searchInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private resultsContainer!: HTMLElement;
  private indexBtn!: HTMLButtonElement;

  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private indexingInProgress = false;

  constructor(
    leaf: WorkspaceLeaf,
    searchEngine: SearchEngine,
    store: VectorStore,
    indexer: Indexer,
    getSettings: () => VaultMindSettings
  ) {
    super(leaf);
    this.searchEngine = searchEngine;
    this.store = store;
    this.indexer = indexer;
    this.getSettings = getSettings;
    this.settings = getSettings();
  }

  getViewType(): string {
    return VIEW_TYPE_VAULT_MIND;
  }

  getDisplayText(): string {
    return "Vault Mind";
  }

  getIcon(): string {
    return "brain-circuit";
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onOpen(): Promise<void> {
    this.settings = this.getSettings();
    this.buildUI();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async onClose(): Promise<void> {
    this.indexer.abort();
  }

  /** Refresh settings (called from main when user saves settings) */
  refreshSettings(): void {
    this.settings = this.getSettings();
  }

  /** Update the status bar text */
  setStatus(text: string, isError = false): void {
    this.statusEl.setText(text);
    this.statusEl.toggleClass("vault-mind-status-error", isError);
  }

  /** Called from main.ts during incremental file changes */
  onFileIndexed(): void {
    this.setStatus(`${this.store.noteCount} notes indexed`);
  }

  // ---------------------------------------------------------------------------
  // UI Construction
  // ---------------------------------------------------------------------------

  private buildUI(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("vault-mind-container");

    // --- Header ---
    const header = container.createDiv({ cls: "vault-mind-header" });
    header.createEl("span", { text: "Vault Mind", cls: "vault-mind-title" });

    // Index button
    this.indexBtn = header.createEl("button", {
      text: "Index",
      cls: "vault-mind-index-btn",
      attr: { "aria-label": "Re-index vault" },
    });
    this.indexBtn.addEventListener("click", () => void this.triggerIndex(false));

    // --- Search input ---
    const searchWrap = container.createDiv({ cls: "vault-mind-search-wrap" });
    this.searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search your vault...",
      cls: "vault-mind-input",
    });
    this.searchInput.addEventListener("input", () => this.onSearchInput());
    this.searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.searchInput.value = "";
        this.clearResults();
      }
    });

    // --- Status line ---
    const noteCount = this.store.noteCount;
    this.statusEl = container.createDiv({
      cls: "vault-mind-status",
      text: noteCount > 0 ? `${noteCount} notes indexed` : "Vault not indexed yet",
    });

    // --- Results container ---
    this.resultsContainer = container.createDiv({ cls: "vault-mind-results" });

    // Auto-focus search input
    this.searchInput.focus();
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  private onSearchInput(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => void this.runSearch(), 300);
  }

  private async runSearch(): Promise<void> {
    const query = this.searchInput.value.trim();

    if (!query) {
      this.clearResults();
      return;
    }

    if (this.store.noteCount === 0) {
      this.setStatus("No notes indexed. Click 'Index' to get started.", true);
      return;
    }

    this.setStatus("Searching...");

    try {
      const settings = this.getSettings();
      const results = await this.searchEngine.search(query, settings.maxResults);
      this.renderResults(results, query);
      this.setStatus(
        results.length > 0
          ? `${results.length} results for "${query}"`
          : `No results for "${query}"`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(msg, true);
      this.clearResults();
    }
  }

  private renderResults(results: SearchResult[], query: string): void {
    this.resultsContainer.empty();

    if (results.length === 0) {
      this.resultsContainer.createDiv({
        cls: "vault-mind-no-results",
        text: "No matching notes found.",
      });
      return;
    }

    for (const result of results) {
      const item = this.resultsContainer.createDiv({ cls: "vault-mind-result-item" });

      // Score badge
      const scorePct = Math.round(result.score * 100);
      item.createSpan({
        cls: "vault-mind-score",
        text: `${scorePct}%`,
        attr: { "aria-label": `${scorePct}% similarity` },
      });

      // Title — clickable to open note
      const titleEl = item.createEl("span", {
        cls: "vault-mind-result-title",
        text: result.title,
      });

      // Snippet with query highlighting
      const snippetEl = item.createDiv({ cls: "vault-mind-snippet" });
      this.renderHighlightedSnippet(snippetEl, result.snippet, query);

      // Click handler — open the note
      item.addEventListener("click", () => {
        void this.openNote(result.path);
      });

      // Keyboard accessibility
      item.setAttribute("tabindex", "0");
      item.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          void this.openNote(result.path);
        }
      });

      // Hover path tooltip
      item.setAttribute("title", result.path);

      void titleEl; // suppress unused warning
    }
  }

  /** Highlight query words in the snippet text */
  private renderHighlightedSnippet(
    el: HTMLElement,
    snippet: string,
    query: string
  ): void {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2); // skip short stop-words

    if (words.length === 0) {
      el.setText(snippet);
      return;
    }

    // Build regex that matches any query word
    const pattern = new RegExp(
      `(${words.map(escapeRegex).join("|")})`,
      "gi"
    );

    const parts = snippet.split(pattern);
    for (const part of parts) {
      if (pattern.test(part)) {
        el.createEl("mark", { cls: "vault-mind-highlight", text: part });
      } else {
        el.appendText(part);
      }
    }
  }

  private async openNote(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.setStatus(`Note not found: ${path}`, true);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true });

    // If it opened as a MarkdownView, scroll to the top
    // currentMode.scroll() is not typed in the obsidian API typedefs,
    // so we access it via a safe cast to avoid the TS error while
    // still getting the scroll-to-top behaviour at runtime.
    const view = leaf.view;
    if (view instanceof MarkdownView) {
      const mode = view.currentMode as unknown as { scroll?: (pos: number) => void };
      if (typeof mode.scroll === "function") {
        mode.scroll(0);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  async triggerIndex(fullReindex: boolean): Promise<void> {
    if (this.indexingInProgress) {
      this.indexer.abort();
      this.setStatus("Indexing stopped.");
      this.indexingInProgress = false;
      this.indexBtn.setText("Index");
      return;
    }

    this.indexingInProgress = true;
    this.indexBtn.setText("Stop");
    this.clearResults();

    try {
      await this.indexer.indexVault((progress: IndexProgress) => {
        this.onIndexProgress(progress);
      }, fullReindex);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setStatus(`Indexing failed: ${msg}`, true);
    } finally {
      this.indexingInProgress = false;
      this.indexBtn.setText("Index");
    }
  }

  private onIndexProgress(progress: IndexProgress): void {
    switch (progress.phase) {
      case "scanning":
        this.setStatus("Scanning vault...");
        break;
      case "embedding":
        this.setStatus(
          `Indexing ${progress.indexed + 1}/${progress.total}: ${progress.currentFile}`
        );
        break;
      case "saving":
        this.setStatus("Saving index...");
        break;
      case "done":
        this.setStatus(`${this.store.noteCount} notes indexed`);
        break;
      case "error":
        // Non-fatal — indexing continues, just show the last error
        this.setStatus(
          `Error on "${progress.currentFile}": ${progress.error ?? "unknown"}`,
          true
        );
        break;
    }
  }

  private clearResults(): void {
    this.resultsContainer.empty();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
