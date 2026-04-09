import type { EmbeddingProvider } from "./types.js";

const DEFAULT_MODEL = "voyage-3-lite";
const DEFAULT_BASE_URL = "https://api.voyageai.com/v1";

export interface VoyageOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

/**
 * Voyage AI embedding provider.
 * Uses the Voyage batch embeddings API.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private dimensionsDetected: boolean;

  constructor(opts: VoyageOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.dimensions = opts.dimensions ?? 0;
    this.dimensionsDetected = opts.dimensions != null && opts.dimensions > 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: "document",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Voyage embedding API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    const results = data.data.map((d) => d.embedding);
    if (!this.dimensionsDetected && results.length > 0) {
      this.dimensions = results[0].length;
      this.dimensionsDetected = true;
    }
    return results;
  }
}
