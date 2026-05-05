import type { EmbeddingProvider } from "./types.js";

const DEFAULT_BATCH_LIMIT = 100;

export interface HttpEmbeddingOptions {
  url: string;
  headers?: Record<string, string>;
  dimensions: number;
  batchLimit?: number;
}

/**
 * Custom HTTP embedding provider.
 * POSTs texts to a URL, expects { embeddings: number[][] } response.
 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private url: string;
  private headers: Record<string, string>;
  private batchLimit: number;

  constructor(opts: HttpEmbeddingOptions) {
    this.url = opts.url;
    this.headers = opts.headers ?? {};
    this.dimensions = opts.dimensions;
    this.batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchLimit) {
      const batch = texts.slice(i, i + this.batchLimit);
      const result = await this.embedBatch(batch);
      all.push(...result);
    }
    return all;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify({ texts }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP embedding API error ${response.status}: ${body}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    if (!Array.isArray(data.embeddings)) {
      throw new Error("HTTP embedding API response missing 'embeddings' array");
    }
    return data.embeddings;
  }
}
