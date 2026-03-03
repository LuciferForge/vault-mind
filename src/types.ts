/**
 * types.ts — Shared type definitions for Vault Mind
 * All cross-module contracts live here. No circular deps.
 */

export interface VaultMindSettings {
  ollamaEndpoint: string;       // e.g. http://localhost:11434
  embeddingModel: string;       // e.g. nomic-embed-text
  maxResults: number;           // how many results to show
  autoIndexOnStartup: boolean;  // index vault on plugin load
  chunkSize: number;            // notes per batch during indexing
}

export const DEFAULT_SETTINGS: VaultMindSettings = {
  ollamaEndpoint: "http://localhost:11434",
  embeddingModel: "nomic-embed-text",
  maxResults: 10,
  autoIndexOnStartup: true,
  chunkSize: 10,
};

/** One entry in the JSON metadata sidecar */
export interface NoteMetadata {
  path: string;       // vault-relative path, e.g. "folder/note.md"
  mtime: number;      // last modified epoch ms — used for incremental updates
  vectorIndex: number; // position of this note's embedding in the .bin Float32Array
  title: string;      // display name (filename without extension)
  snippet: string;    // first 200 chars of content — shown in search results
}

/** In-memory metadata store */
export interface VectorIndex {
  dimensions: number;                    // embedding dimensions (768 for nomic-embed-text)
  notes: Record<string, NoteMetadata>;   // keyed by vault-relative path
}

/** A single search result */
export interface SearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number; // cosine similarity 0-1
}

/** Progress update during indexing */
export interface IndexProgress {
  indexed: number;
  total: number;
  currentFile: string;
  phase: "scanning" | "embedding" | "saving" | "done" | "error";
  error?: string;
}

/** Ollama embeddings API response */
export interface OllamaEmbeddingResponse {
  embedding: number[];
}

/** Ollama API error shape */
export interface OllamaError {
  error: string;
}
