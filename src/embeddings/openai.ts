import type { EmbeddingProvider } from "./types.js";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSIONS = 256;
const BATCH_LIMIT = 100; // OpenAI max batch size

export interface OpenAIOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
}

/**
 * OpenAI embedding provider.
 * Uses native fetch (Node 20+), no HTTP library dependency.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts: OpenAIOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dimensions = opts.dimensions ?? DEFAULT_DIMENSIONS;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com";
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Batch if needed
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
      const batch = texts.slice(i, i + BATCH_LIMIT);
      const batchResults = await this.embedBatch(batch);
      results.push(...batchResults);
    }
    return results;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenAI embedding API error ${response.status}: ${body}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index (API may return out of order)
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
