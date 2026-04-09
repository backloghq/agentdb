/** Interface for embedding providers. */
export interface EmbeddingProvider {
  /** Generate embeddings for a batch of texts. Returns one vector per text. */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimension of generated vectors. */
  readonly dimensions: number;
}

/** Configuration for embedding providers. */
export type EmbeddingConfig =
  | { provider: "openai"; apiKey: string; model?: string; dimensions?: number }
  | { provider: "http"; url: string; headers?: Record<string, string>; dimensions: number }
  | { provider: EmbeddingProvider };
