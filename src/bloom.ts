/**
 * Bloom filter for fast probabilistic existence checks.
 * "Does any record have field X = Y?" — false positives possible, no false negatives.
 */

export class BloomFilter {
  private bits: Uint8Array;
  private size: number;
  private hashCount: number;

  /**
   * @param expectedItems Expected number of items
   * @param falsePositiveRate Target false positive rate (default 0.01 = 1%)
   */
  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    // Optimal bit array size: -n*ln(p) / (ln2)^2
    this.size = Math.max(
      64,
      Math.ceil((-expectedItems * Math.log(falsePositiveRate)) / (Math.LN2 * Math.LN2)),
    );
    // Optimal number of hash functions: (m/n) * ln2
    this.hashCount = Math.max(1, Math.round((this.size / expectedItems) * Math.LN2));
    this.bits = new Uint8Array(Math.ceil(this.size / 8));
  }

  /** Add a value to the filter. */
  add(value: string): void {
    for (const pos of this.getPositions(value)) {
      this.bits[pos >>> 3] |= 1 << (pos & 7);
    }
  }

  /** Check if a value might exist. False = definitely not present. True = probably present. */
  has(value: string): boolean {
    for (const pos of this.getPositions(value)) {
      if ((this.bits[pos >>> 3] & (1 << (pos & 7))) === 0) return false;
    }
    return true;
  }

  /** Number of bits in the filter. */
  get bitCount(): number {
    return this.size;
  }

  /** Clear the filter. */
  clear(): void {
    this.bits.fill(0);
  }

  /** Get bit positions for a value using double hashing. */
  private getPositions(value: string): number[] {
    const h1 = this.hash1(value);
    const h2 = this.hash2(value);
    const positions: number[] = [];
    for (let i = 0; i < this.hashCount; i++) {
      positions.push(Math.abs((h1 + i * h2) % this.size));
    }
    return positions;
  }

  /** FNV-1a hash. */
  private hash1(value: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash;
  }

  /** DJB2 hash. */
  private hash2(value: string): number {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
    }
    return hash || 1; // Avoid 0
  }
}
