import type { EmbeddingProvider } from "./types.js";

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://localhost:11434";

export interface OllamaOptions {
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

/**
 * Ollama embedding provider.
 * Uses the local Ollama API for embeddings (single-text endpoint, batched sequentially).
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  private model: string;
  private baseUrl: string;
  private dimensionsDetected: boolean;

  constructor(opts: OllamaOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.dimensions = opts.dimensions ?? 0;
    this.dimensionsDetected = opts.dimensions != null && opts.dimensions > 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    for (const text of texts) {
      const embedding = await this.embedSingle(text);
      if (!this.dimensionsDetected) {
        this.dimensions = embedding.length;
        this.dimensionsDetected = true;
      }
      results.push(embedding);
    }
    return results;
  }

  private async embedSingle(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Ollama embedding API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }
}
