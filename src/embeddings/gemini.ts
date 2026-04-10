import type { EmbeddingProvider } from "./types.js";

const DEFAULT_MODEL = "gemini-embedding-001";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  dimensions?: number;
}

/**
 * Gemini embedding provider.
 * Uses the Gemini embedContent REST API. Supports configurable output dimensionality.
 * Free tier available at https://aistudio.google.com/apikey
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private dimensionsDetected: boolean;

  constructor(opts: GeminiEmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.dimensions = opts.dimensions ?? 0;
    this.dimensionsDetected = opts.dimensions != null && opts.dimensions > 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Gemini embedContent supports multiple parts in a single request
    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:embedContent?key=${this.apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: { parts: texts.map(text => ({ text })) },
          ...(this.dimensionsDetected ? { output_dimensionality: this.dimensions } : {}),
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gemini embedding API error ${response.status}: ${body}`);
    }

    const data = await response.json() as { embedding?: { values: number[] }; embeddings?: Array<{ values: number[] }> };

    // Single embedding response
    if (data.embedding) {
      const vec = data.embedding.values;
      if (!this.dimensionsDetected) {
        this.dimensions = vec.length;
        this.dimensionsDetected = true;
      }
      // If multiple texts were sent but API returned single embedding, embed individually
      if (texts.length > 1) {
        return this.embedIndividually(texts);
      }
      return [vec];
    }

    // Batch embedding response
    if (data.embeddings) {
      const results = data.embeddings.map(e => e.values);
      if (!this.dimensionsDetected && results.length > 0) {
        this.dimensions = results[0].length;
        this.dimensionsDetected = true;
      }
      return results;
    }

    throw new Error("Gemini embedding API: unexpected response format");
  }

  private async embedIndividually(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      const [vec] = await this.embed([text]);
      results.push(vec);
    }
    return results;
  }
}
