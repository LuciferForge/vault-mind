/**
 * vectorStore.ts — Binary Float32Array + JSON metadata persistence
 *
 * Design decisions from SCOUT report:
 * - No SQLite: Obsidian rejects native binaries. Pure JS only.
 * - Two files: vault-mind.bin (raw float bytes) + vault-mind-index.json (metadata)
 * - Float32Array: 4 bytes/dimension. 768 dims * 20k notes = ~61MB max. Acceptable.
 * - Incremental: mtime-based change detection, no full re-index needed.
 *
 * File layout in plugin data dir:
 *   vault-mind.bin         — flat buffer: [note0_dim0..note0_dim767, note1_dim0..., ...]
 *   vault-mind-index.json  — VectorIndex (path → NoteMetadata)
 */

import { App } from "obsidian";
import { NoteMetadata, VectorIndex } from "./types";

const BIN_FILE = "vault-mind.bin";
const INDEX_FILE = "vault-mind-index.json";

export class VectorStore {
  private app: App;
  private pluginId: string;
  private index: VectorIndex;
  private buffer: Float32Array;
  private dirty = false;

  /** Next available slot in the flat buffer */
  private nextSlot = 0;

  /** Recycled slots from deleted notes — reuse before growing buffer */
  private freeSlots: number[] = [];

  constructor(app: App, pluginId: string) {
    this.app = app;
    this.pluginId = pluginId;
    this.index = { dimensions: 0, notes: {} };
    this.buffer = new Float32Array(0);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** Load existing data from disk. Call once on plugin startup. */
  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.dataDir();

    const indexPath = `${dir}/${INDEX_FILE}`;
    const binPath = `${dir}/${BIN_FILE}`;

    const indexExists = await adapter.exists(indexPath);
    const binExists = await adapter.exists(binPath);

    if (!indexExists || !binExists) {
      // Fresh install — initialize empty state
      this.index = { dimensions: 0, notes: {} };
      this.buffer = new Float32Array(0);
      this.nextSlot = 0;
      this.freeSlots = [];
      return;
    }

    // Load JSON index
    const indexRaw = await adapter.read(indexPath);
    const parsed = JSON.parse(indexRaw) as VectorIndex & { freeSlots?: number[]; nextSlot?: number };
    this.index = { dimensions: parsed.dimensions, notes: parsed.notes };
    this.freeSlots = parsed.freeSlots ?? [];
    this.nextSlot = parsed.nextSlot ?? this.computeNextSlot();

    // Load binary buffer
    const binRaw = await adapter.readBinary(binPath);
    this.buffer = new Float32Array(binRaw);
  }

  /** Flush current state to disk. Call after batch indexing completes. */
  async save(): Promise<void> {
    if (!this.dirty) return;

    const adapter = this.app.vault.adapter;
    const dir = this.dataDir();

    // Ensure data directory exists
    if (!(await adapter.exists(dir))) {
      await adapter.mkdir(dir);
    }

    // Write JSON index (includes freeSlots and nextSlot for perfect reload)
    const indexData = {
      ...this.index,
      freeSlots: this.freeSlots,
      nextSlot: this.nextSlot,
    };
    await adapter.write(`${dir}/${INDEX_FILE}`, JSON.stringify(indexData, null, 2));

    // Write binary buffer
    await adapter.writeBinary(`${dir}/${BIN_FILE}`, this.buffer.buffer as ArrayBuffer);

    this.dirty = false;
  }

  // ---------------------------------------------------------------------------
  // Mutation
  // ---------------------------------------------------------------------------

  /**
   * Add or update an embedding for a note.
   * If the note already exists, overwrites its slot in-place.
   */
  addEmbedding(
    path: string,
    embedding: Float32Array,
    mtime: number,
    title: string,
    snippet: string
  ): void {
    const dims = embedding.length;

    // First embedding determines dimension for this store
    if (this.index.dimensions === 0) {
      this.index.dimensions = dims;
    } else if (dims !== this.index.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: store expects ${this.index.dimensions}, got ${dims}. ` +
        `Did you change models mid-index? Run 'Re-index Vault' to rebuild from scratch.`
      );
    }

    const existing = this.index.notes[path];

    if (existing) {
      // Overwrite existing slot — buffer doesn't change size
      const offset = existing.vectorIndex * dims;
      this.buffer.set(embedding, offset);
      existing.mtime = mtime;
      existing.snippet = snippet;
      this.dirty = true;
      return;
    }

    // New note — get a slot
    let slot: number;
    if (this.freeSlots.length > 0) {
      slot = this.freeSlots.pop()!;
    } else {
      slot = this.nextSlot++;
    }

    // Grow buffer if needed
    const requiredLength = (slot + 1) * dims;
    if (requiredLength > this.buffer.length) {
      // Grow with headroom — double capacity to avoid thrashing
      const newCapacity = Math.max(requiredLength, this.buffer.length * 2 || dims * 100);
      const newBuffer = new Float32Array(newCapacity);
      newBuffer.set(this.buffer);
      this.buffer = newBuffer;
    }

    // Write embedding into buffer
    const offset = slot * dims;
    this.buffer.set(embedding, offset);

    // Register metadata
    this.index.notes[path] = {
      path,
      mtime,
      vectorIndex: slot,
      title,
      snippet,
    };

    this.dirty = true;
  }

  /**
   * Remove a note from the store.
   * Frees its slot for reuse — no buffer compaction needed.
   */
  removeEmbedding(path: string): void {
    const meta = this.index.notes[path];
    if (!meta) return;

    this.freeSlots.push(meta.vectorIndex);
    delete this.index.notes[path];
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /** Return all note metadata entries as an array */
  getAllMetadata(): NoteMetadata[] {
    return Object.values(this.index.notes);
  }

  /** Return metadata for a specific path, or undefined */
  getMetadata(path: string): NoteMetadata | undefined {
    return this.index.notes[path];
  }

  /**
   * Get the embedding vector for a specific note by its slot index.
   * Returns a view into the internal buffer — do not mutate.
   */
  getEmbedding(vectorIndex: number): Float32Array {
    const dims = this.index.dimensions;
    const offset = vectorIndex * dims;
    return this.buffer.subarray(offset, offset + dims);
  }

  get dimensions(): number {
    return this.index.dimensions;
  }

  get noteCount(): number {
    return Object.keys(this.index.notes).length;
  }

  /** True if path exists in index AND its mtime matches stored value */
  isUpToDate(path: string, mtime: number): boolean {
    const meta = this.index.notes[path];
    return meta !== undefined && meta.mtime === mtime;
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Wipe all data — called when user triggers full re-index */
  clear(): void {
    this.index = { dimensions: 0, notes: {} };
    this.buffer = new Float32Array(0);
    this.nextSlot = 0;
    this.freeSlots = [];
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private dataDir(): string {
    return `.obsidian/plugins/${this.pluginId}/data`;
  }

  private computeNextSlot(): number {
    const slots = Object.values(this.index.notes).map((n) => n.vectorIndex);
    return slots.length > 0 ? Math.max(...slots) + 1 : 0;
  }
}
