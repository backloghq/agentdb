export type { EmbeddingProvider, EmbeddingConfig } from "./types.js";
export { OpenAIEmbeddingProvider } from "./openai.js";
export { HttpEmbeddingProvider } from "./http.js";
export { OllamaEmbeddingProvider } from "./ollama.js";
export { VoyageEmbeddingProvider } from "./voyage.js";
export { CohereEmbeddingProvider } from "./cohere.js";

import type { EmbeddingProvider, EmbeddingConfig } from "./types.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import { HttpEmbeddingProvider } from "./http.js";
import { OllamaEmbeddingProvider } from "./ollama.js";
import { VoyageEmbeddingProvider } from "./voyage.js";
import { CohereEmbeddingProvider } from "./cohere.js";

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
  if (config.provider === "ollama") {
    return new OllamaEmbeddingProvider({
      model: config.model,
      baseUrl: config.baseUrl,
      dimensions: config.dimensions,
    });
  }
  if (config.provider === "voyage") {
    return new VoyageEmbeddingProvider({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      dimensions: config.dimensions,
    });
  }
  if (config.provider === "cohere") {
    return new CohereEmbeddingProvider({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      inputType: config.inputType,
      dimensions: config.dimensions,
    });
  }
  throw new Error(`Unknown embedding provider: ${(config as { provider: string }).provider}`);
}
