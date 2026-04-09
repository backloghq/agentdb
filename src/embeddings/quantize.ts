/**
 * Int8 quantization for embedding vectors.
 * Reduces storage by 4x (float32 → int8) with minimal accuracy loss.
 */

/**
 * Quantize a float32 vector to int8.
 * Stores the scale factor alongside for dequantization.
 */
export function quantize(vector: number[]): { data: Int8Array; scale: number } {
  if (vector.length === 0) return { data: new Int8Array(0), scale: 1 };

  let maxAbs = 0;
  for (const v of vector) {
    const abs = Math.abs(v);
    if (abs > maxAbs) maxAbs = abs;
  }

  const scale = maxAbs === 0 ? 1 : 127 / maxAbs;
  const data = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    data[i] = Math.round(vector[i] * scale);
  }

  return { data, scale };
}

/**
 * Dequantize an int8 vector back to float32.
 */
export function dequantize(data: Int8Array, scale: number): number[] {
  const result = new Array<number>(data.length);
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] / scale;
  }
  return result;
}

/**
 * Compute cosine similarity between two int8 vectors.
 * Uses integer arithmetic for speed, returns float result.
 */
export function cosineSimilarityInt8(a: Int8Array, b: Int8Array): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute cosine similarity between two float32 vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vector dimension mismatch");
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize a quantized vector for storage (JSON-compatible).
 */
export function serializeQuantized(q: { data: Int8Array; scale: number }): { data: number[]; scale: number } {
  return { data: Array.from(q.data), scale: q.scale };
}

/**
 * Deserialize a stored quantized vector.
 */
export function deserializeQuantized(stored: { data: number[]; scale: number }): { data: Int8Array; scale: number } {
  return { data: Int8Array.from(stored.data), scale: stored.scale };
}
