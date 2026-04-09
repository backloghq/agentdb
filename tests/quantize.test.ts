import { describe, it, expect } from "vitest";
import {
  quantize,
  dequantize,
  cosineSimilarity,
  cosineSimilarityInt8,
  serializeQuantized,
  deserializeQuantized,
} from "../src/embeddings/quantize.js";

describe("Quantization", () => {
  describe("quantize / dequantize", () => {
    it("round-trips with minimal loss", () => {
      const original = [0.1, -0.5, 0.3, 0.8, -0.2];
      const q = quantize(original);
      const restored = dequantize(q.data, q.scale);

      for (let i = 0; i < original.length; i++) {
        expect(restored[i]).toBeCloseTo(original[i], 1); // ~1 decimal accuracy
      }
    });

    it("quantized vectors are int8", () => {
      const q = quantize([0.1, -0.5, 0.3, 0.8]);
      expect(q.data).toBeInstanceOf(Int8Array);
      expect(q.data.length).toBe(4);
      for (const v of q.data) {
        expect(v).toBeGreaterThanOrEqual(-128);
        expect(v).toBeLessThanOrEqual(127);
      }
    });

    it("handles zero vector", () => {
      const q = quantize([0, 0, 0, 0]);
      expect(q.scale).toBe(1);
      expect(Array.from(q.data)).toEqual([0, 0, 0, 0]);
    });

    it("handles empty vector", () => {
      const q = quantize([]);
      expect(q.data.length).toBe(0);
    });

    it("max value maps to 127", () => {
      const q = quantize([1.0, -1.0, 0.5]);
      expect(q.data[0]).toBe(127);
      expect(q.data[1]).toBe(-127);
    });
  });

  describe("cosineSimilarity", () => {
    it("identical vectors have similarity 1", () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    });

    it("opposite vectors have similarity -1", () => {
      expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 5);
    });

    it("orthogonal vectors have similarity 0", () => {
      expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
    });

    it("similar vectors have high similarity", () => {
      const sim = cosineSimilarity([0.9, 0.1, 0.0], [0.8, 0.2, 0.0]);
      expect(sim).toBeGreaterThan(0.9);
    });

    it("handles zero vector", () => {
      expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
    });

    it("throws on dimension mismatch", () => {
      expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow("mismatch");
    });
  });

  describe("cosineSimilarityInt8", () => {
    it("approximates float cosine similarity", () => {
      const a = [0.9, 0.1, -0.3, 0.5];
      const b = [0.8, 0.2, -0.2, 0.6];

      const floatSim = cosineSimilarity(a, b);
      const qa = quantize(a);
      const qb = quantize(b);
      const int8Sim = cosineSimilarityInt8(qa.data, qb.data);

      // Should be close (within ~2% of float)
      expect(Math.abs(floatSim - int8Sim)).toBeLessThan(0.05);
    });

    it("throws on dimension mismatch", () => {
      expect(() =>
        cosineSimilarityInt8(Int8Array.from([1, 0]), Int8Array.from([1, 0, 0])),
      ).toThrow("mismatch");
    });
  });

  describe("serialization", () => {
    it("round-trips through JSON", () => {
      const original = quantize([0.5, -0.3, 0.8, -0.1]);
      const serialized = serializeQuantized(original);
      const json = JSON.stringify(serialized);
      const parsed = JSON.parse(json);
      const restored = deserializeQuantized(parsed);

      expect(restored.scale).toBe(original.scale);
      expect(Array.from(restored.data)).toEqual(Array.from(original.data));
    });
  });
});
