export type { EmbeddingProvider, EmbeddingConfig } from "./types.js";
export { OpenAIEmbeddingProvider } from "./openai.js";
export { HttpEmbeddingProvider } from "./http.js";

import type { EmbeddingProvider, EmbeddingConfig } from "./types.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import { HttpEmbeddingProvider } from "./http.js";

/** Resolve an embedding config to a provider instance. */
export function resolveProvider(config: EmbeddingConfig): EmbeddingProvider {
  if ("provider" in config && typeof config.provider === "object") {
    return config.provider;
  }
  if (config.provider === "openai") {
    return new OpenAIEmbeddingProvider({
      apiKey: config.apiKey,
      model: config.model,
      dimensions: config.dimensions,
    });
  }
  if (config.provider === "http") {
    return new HttpEmbeddingProvider({
      url: config.url,
      headers: config.headers,
      dimensions: config.dimensions,
    });
  }
  throw new Error(`Unknown embedding provider: ${(config as { provider: string }).provider}`);
}
