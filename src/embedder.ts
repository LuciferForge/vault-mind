/**
 * embedder.ts — Ollama REST client for generating embeddings
 *
 * Calls POST /api/embeddings on a local Ollama instance.
 * All network errors produce clear, actionable messages — no cryptic stack traces.
 * This module is intentionally stateless; callers manage model/endpoint config.
 */

import { requestUrl } from "obsidian";
import { OllamaEmbeddingResponse } from "./types";

export class OllamaEmbedder {
  private endpoint: string;
  private model: string;

  constructor(endpoint: string, model: string) {
    // Normalize: strip trailing slash so callers don't have to think about it
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  /** Update config without creating a new instance */
  configure(endpoint: string, model: string): void {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  /**
   * Generate an embedding vector for the given text.
   * Returns a Float32Array for memory efficiency.
   * Throws descriptive Error on any failure.
   */
  async embed(text: string): Promise<Float32Array> {
    const url = `${this.endpoint}/api/embeddings`;

    let data: OllamaEmbeddingResponse;
    try {
      const resp = await requestUrl({
        url,
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({
          model: this.model,
          prompt: text,
        }),
        throw: false,
      });

      if (resp.status !== 200) {
        throw new Error(
          `Ollama returned HTTP ${resp.status} for model "${this.model}". ` +
          `Is the model downloaded? Run: \`ollama pull ${this.model}\`. ` +
          `Response: ${resp.text}`
        );
      }

      data = resp.json as OllamaEmbeddingResponse;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("HTTP")) throw e as Error;
      throw new Error(
        `Cannot reach Ollama at ${this.endpoint}. ` +
        `Make sure Ollama is running: \`ollama serve\`. ` +
        `Original error: ${msg}`
      );
    }

    if (!data.embedding || !Array.isArray(data.embedding)) {
      throw new Error(
        `Ollama response missing "embedding" field. ` +
        `Got: ${JSON.stringify(data).slice(0, 200)}`
      );
    }

    return new Float32Array(data.embedding);
  }

  /**
   * Verify connectivity and model availability.
   * Returns { ok: true } or { ok: false, reason: string }
   */
  async healthCheck(): Promise<{ ok: boolean; reason?: string }> {
    try {
      // Check if Ollama is up
      const tagsUrl = `${this.endpoint}/api/tags`;
      const tagsResp = await requestUrl({ url: tagsUrl, throw: false });
      if (tagsResp.status !== 200) {
        return { ok: false, reason: `Ollama server returned HTTP ${tagsResp.status}` };
      }

      const tagsData = tagsResp.json as { models?: Array<{ name: string }> };
      const models = tagsData.models ?? [];
      const modelNames = models.map((m) => m.name);

      // Check if our target model is pulled — Ollama names include tags like "nomic-embed-text:latest"
      const modelAvailable = modelNames.some(
        (n) => n === this.model || n.startsWith(this.model + ":")
      );

      if (!modelAvailable) {
        return {
          ok: false,
          reason:
            `Model "${this.model}" not found in Ollama. ` +
            `Run: \`ollama pull ${this.model}\`. ` +
            `Available models: ${modelNames.join(", ") || "none"}`,
        };
      }

      return { ok: true };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        reason: `Cannot reach Ollama at ${this.endpoint}. Run \`ollama serve\`. Error: ${msg}`,
      };
    }
  }

  get currentModel(): string {
    return this.model;
  }

  get currentEndpoint(): string {
    return this.endpoint;
  }
}
