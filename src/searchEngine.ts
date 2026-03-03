/**
 * searchEngine.ts — Pure TypeScript cosine similarity search
 *
 * No WebAssembly, no native deps. Handles 20k notes comfortably:
 * 20k * 768 dims = 15.3M multiply-add ops. At JS's ~1 GFLOP/s, that's ~15ms.
 * Acceptable latency for an interactive search.
 *
 * If we ever need to scale past 100k notes, this is the module to swap for
 * a WASM-based FAISS wrapper. The interface is stable regardless.
 */

import { OllamaEmbedder } from "./embedder";
import { VectorStore } from "./vectorStore";
import { SearchResult } from "./types";

export class SearchEngine {
  private embedder: OllamaEmbedder;
  private store: VectorStore;

  constructor(embedder: OllamaEmbedder, store: VectorStore) {
    this.embedder = embedder;
    this.store = store;
  }

  /**
   * Run a semantic search query.
   * Embeds the query text, then scores all notes by cosine similarity.
   * Returns top-k results sorted descending by score.
   */
  async search(query: string, topK: number): Promise<SearchResult[]> {
    if (this.store.noteCount === 0) {
      return [];
    }

    if (!query.trim()) {
      return [];
    }

    // Embed the query
    const queryVec = await this.embedder.embed(query);

    // Precompute query magnitude once — reused across all dot products
    const queryMag = magnitude(queryVec);
    if (queryMag === 0) return [];

    // Score all indexed notes
    const results: SearchResult[] = [];
    const allMeta = this.store.getAllMetadata();

    for (const meta of allMeta) {
      const noteVec = this.store.getEmbedding(meta.vectorIndex);
      if (noteVec.length !== queryVec.length) continue; // dimension mismatch — skip gracefully

      const noteMag = magnitude(noteVec);
      if (noteMag === 0) continue;

      const score = dotProduct(queryVec, noteVec) / (queryMag * noteMag);

      results.push({
        path: meta.path,
        title: meta.title,
        snippet: meta.snippet,
        score,
      });
    }

    // Sort descending by score, return top-k
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

// ---------------------------------------------------------------------------
// SIMD-friendly math helpers
// These tight loops are what the JS JIT will optimize best.
// Keeping them at module scope avoids closure overhead in hot paths.
// ---------------------------------------------------------------------------

/** Euclidean magnitude of a Float32Array */
function magnitude(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    sum += vec[i] * vec[i];
  }
  return Math.sqrt(sum);
}

/** Dot product of two equal-length Float32Arrays */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = a.length;
  // Unroll 4x to hint JIT toward vectorization
  const block = len - (len % 4);
  let i = 0;
  for (; i < block; i += 4) {
    sum += a[i] * b[i] + a[i+1] * b[i+1] + a[i+2] * b[i+2] + a[i+3] * b[i+3];
  }
  for (; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
