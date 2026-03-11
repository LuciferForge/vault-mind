/**
 * main.ts — Vault Mind plugin entry point
 *
 * Lifecycle:
 *   onload() → load settings → load vector store → wire up Ollama embedder
 *            → register view → open sidebar → optionally trigger index on startup
 *            → register file watchers for incremental updates
 *
 *   onunload() → abort any running index → view cleanup handled by Obsidian
 *
 * File watchers use a 3s debounce — aggressive enough to catch saves, forgiving
 * enough not to hammer Ollama on every keystroke if the user has live preview on.
 */

import {
  Plugin,
  WorkspaceLeaf,
  TFile,
  TAbstractFile,
  Notice,
} from "obsidian";

import { VaultMindSettings, DEFAULT_SETTINGS } from "./types";
import { OllamaEmbedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { SearchEngine } from "./searchEngine";
import { Indexer } from "./indexer";
import { VaultMindView, VIEW_TYPE_VAULT_MIND } from "./searchView";
import { VaultMindSettingsTab } from "./settings";

export default class VaultMindPlugin extends Plugin {
  settings!: VaultMindSettings;

  private embedder!: OllamaEmbedder;
  private store!: VectorStore;
  private searchEngine!: SearchEngine;
  private indexer!: Indexer;

  // Debounce timers for incremental file updates
  private fileUpdateTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private readonly FILE_UPDATE_DEBOUNCE_MS = 3000;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async onload(): Promise<void> {
    console.debug("[Vault mind] Loading plugin");

    // 1. Load user settings
    await this.loadSettings();

    // 2. Initialize core components
    this.embedder = new OllamaEmbedder(
      this.settings.ollamaEndpoint,
      this.settings.embeddingModel
    );

    this.store = new VectorStore(this.app, this.manifest.id);
    await this.store.load();

    this.searchEngine = new SearchEngine(this.embedder, this.store);

    this.indexer = new Indexer(
      this.app,
      this.embedder,
      this.store,
      this.settings.chunkSize
    );

    // 3. Register the search view
    this.registerView(VIEW_TYPE_VAULT_MIND, (leaf: WorkspaceLeaf) => {
      return new VaultMindView(
        leaf,
        this.searchEngine,
        this.store,
        this.indexer,
        () => this.settings
      );
    });

    // 4. Ribbon icon — opens the search panel
    this.addRibbonIcon("brain-circuit", "Vault mind: Semantic search", async () => {
      await this.activateView();
    });

    // 5. Commands
    this.addCommand({
      id: "open-search",
      name: "Open semantic search",
      callback: async () => {
        await this.activateView();
      },
    });

    this.addCommand({
      id: "reindex-vault",
      name: "Re-index vault (full rebuild)",
      callback: async () => {
        await this.triggerFullReindex();
      },
    });

    this.addCommand({
      id: "index-vault-incremental",
      name: "Update index (incremental)",
      callback: async () => {
        await this.triggerIncrementalIndex();
      },
    });

    // 6. Settings tab
    this.addSettingTab(new VaultMindSettingsTab(this.app, this));

    // 7. File watchers — incremental index updates
    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          this.scheduleFileUpdate(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          this.scheduleFileUpdate(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "md") {
          this.store.removeEmbedding(file.path);
          // Fire-and-forget save with debounce
          this.scheduleStoreSave();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile && file.extension === "md") {
          // Remove old path, schedule new path for indexing
          this.store.removeEmbedding(oldPath);
          this.scheduleFileUpdate(file);
        }
      })
    );

    // 8. Auto-index on startup (deferred so vault is fully loaded)
    if (this.settings.autoIndexOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => {
          this.triggerIncrementalIndex().catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[Vault mind] Auto-index failed: ${msg}`);
          });
        }, 2000); // 2s grace period for vault to finish loading
      });
    }

    console.debug("[Vault mind] Plugin loaded");
  }

  onunload(): void {
    console.debug("[Vault mind] Unloading plugin");
    this.indexer.abort();

    // Clear any pending file update timers
    for (const timer of this.fileUpdateTimers.values()) {
      clearTimeout(timer);
    }
    this.fileUpdateTimers.clear();
  }

  // ---------------------------------------------------------------------------
  // Public API (called from settings tab and search view)
  // ---------------------------------------------------------------------------

  getStore(): VectorStore {
    return this.store;
  }

  async triggerFullReindex(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await view.triggerIndex(true);
    } else {
      // No view open — run headlessly with Notice feedback
      new Notice("[Vault mind] Starting full re-index...");
      try {
        await this.indexer.indexVault(() => {}, true);
        new Notice(`[Vault mind] Done. ${this.store.noteCount} notes indexed.`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        new Notice(`[Vault mind] Re-index failed: ${msg}`, 8000);
      }
    }
  }

  async triggerIncrementalIndex(): Promise<void> {
    const view = this.getActiveView();
    if (view) {
      await view.triggerIndex(false);
    } else {
      try {
        await this.indexer.indexVault(() => {}, false);
        const view2 = this.getActiveView();
        if (view2) view2.refreshSettings();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Vault mind] Incremental index failed: ${msg}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);

    // Update embedder config in place — no need to reconstruct
    this.embedder.configure(
      this.settings.ollamaEndpoint,
      this.settings.embeddingModel
    );

    // Propagate to indexer chunk size
    this.indexer = new Indexer(
      this.app,
      this.embedder,
      this.store,
      this.settings.chunkSize
    );

    // Notify the view to refresh its settings reference
    const view = this.getActiveView();
    if (view) view.refreshSettings();
  }

  // ---------------------------------------------------------------------------
  // View management
  // ---------------------------------------------------------------------------

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_VAULT_MIND);

    if (existing.length > 0) {
      void workspace.revealLeaf(existing[0]);
      return;
    }

    // Open in right sidebar
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) {
      // Fallback: open as floating leaf
      const newLeaf = workspace.getLeaf("tab");
      await newLeaf.setViewState({ type: VIEW_TYPE_VAULT_MIND, active: true });
      void workspace.revealLeaf(newLeaf);
      return;
    }

    await leaf.setViewState({ type: VIEW_TYPE_VAULT_MIND, active: true });
    void workspace.revealLeaf(leaf);
  }

  private getActiveView(): VaultMindView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_VAULT_MIND);
    if (leaves.length === 0) return null;
    const view = leaves[0].view;
    return view instanceof VaultMindView ? view : null;
  }

  // ---------------------------------------------------------------------------
  // Incremental file update scheduling
  // ---------------------------------------------------------------------------

  private scheduleFileUpdate(file: TFile): void {
    // Cancel any pending update for this file
    const existing = this.fileUpdateTimers.get(file.path);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.fileUpdateTimers.delete(file.path);
      void (async () => {
        try {
          await this.indexer.indexFile(file);
          this.scheduleStoreSave();

          const view = this.getActiveView();
          if (view) view.onFileIndexed();
        } catch (e: unknown) {
          // Non-fatal — Ollama may be down. Don't spam the user.
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[Vault mind] Failed to index "${file.path}": ${msg}`);
        }
      })();
    }, this.FILE_UPDATE_DEBOUNCE_MS);

    this.fileUpdateTimers.set(file.path, timer);
  }

  // Debounced store save after incremental updates
  private storeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleStoreSave(): void {
    if (this.storeSaveTimer) clearTimeout(this.storeSaveTimer);
    this.storeSaveTimer = setTimeout(() => {
      this.storeSaveTimer = null;
      void this.store.save().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Vault mind] Failed to save index: ${msg}`);
      });
    }, 5000); // 5s after last incremental update
  }
}
