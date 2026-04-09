import type { EmbeddingProvider } from "./types.js";

const DEFAULT_MODEL = "embed-english-v3.0";
const DEFAULT_BASE_URL = "https://api.cohere.com/v2";
const DEFAULT_INPUT_TYPE = "search_document";

export interface CohereOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  inputType?: string;
  dimensions?: number;
}

/**
 * Cohere embedding provider.
 * Uses the Cohere v2 embed API with float embedding type.
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  dimensions: number;
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private inputType: string;
  private dimensionsDetected: boolean;

  constructor(opts: CohereOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.inputType = opts.inputType ?? DEFAULT_INPUT_TYPE;
    this.dimensions = opts.dimensions ?? 0;
    this.dimensionsDetected = opts.dimensions != null && opts.dimensions > 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/embed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        texts,
        input_type: this.inputType,
        embedding_types: ["float"],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Cohere embedding API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      embeddings: { float: number[][] };
    };

    const results = data.embeddings.float;
    if (!this.dimensionsDetected && results.length > 0) {
      this.dimensions = results[0].length;
      this.dimensionsDetected = true;
    }
    return results;
  }
}
