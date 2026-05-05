/**
 * Unit tests for src/config.ts — env var coercion (commit 1) and
 * file loading + precedence (commit 2).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentDBConfig, ConfigValidationError } from "../src/config.js";

/**
 * Helper: call loadAgentDBConfig with env vars injected and no config file.
 * Passes a nonexistent path so the file layer returns {}.
 */
function fromEnv(env: Record<string, string>) {
  return loadAgentDBConfig({ env, configPath: "/nonexistent/no-file.json" });
}

describe("Config env var coercion", () => {
  describe("number coercion", () => {
    it("AGENTDB_MAX_FIND_LIMIT='50000' → db.maxFindLimit === 50000", () => {
      const cfg = fromEnv({ AGENTDB_MAX_FIND_LIMIT: "50000" });
      expect(cfg.db?.maxFindLimit).toBe(50000);
    });

    it("AGENTDB_HTTP_AUDIT_BUFFER_SIZE='20000' → http.auditBufferSize === 20000", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_AUDIT_BUFFER_SIZE: "20000" });
      expect(cfg.http?.auditBufferSize).toBe(20000);
    });

    it("AGENTDB_HNSW_EF_SEARCH='100' → db.hnsw.efSearch === 100", () => {
      const cfg = fromEnv({ AGENTDB_HNSW_EF_SEARCH: "100" });
      expect(cfg.db?.hnsw?.efSearch).toBe(100);
    });

    it("AGENTDB_HNSW_M='8' → db.hnsw.M === 8", () => {
      const cfg = fromEnv({ AGENTDB_HNSW_M: "8" });
      expect(cfg.db?.hnsw?.M).toBe(8);
    });

    it("AGENTDB_CACHE_SIZE='5000' → db.cacheSize === 5000", () => {
      const cfg = fromEnv({ AGENTDB_CACHE_SIZE: "5000" });
      expect(cfg.db?.cacheSize).toBe(5000);
    });

    it("AGENTDB_HTTP_PORT='8080' → http.port === 8080", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_PORT: "8080" });
      expect(cfg.http?.port).toBe(8080);
    });

    it("AGENTDB_MEMORY_BUDGET='0' → db.memoryBudget === 0 (zero is valid)", () => {
      const cfg = fromEnv({ AGENTDB_MEMORY_BUDGET: "0" });
      expect(cfg.db?.memoryBudget).toBe(0);
    });
  });

  describe("number coercion errors", () => {
    it("AGENTDB_HTTP_AUDIT_BUFFER_SIZE='abc' → throws ConfigValidationError", () => {
      expect(() => fromEnv({ AGENTDB_HTTP_AUDIT_BUFFER_SIZE: "abc" })).toThrow(ConfigValidationError);
    });

    it("AGENTDB_HTTP_AUDIT_BUFFER_SIZE='abc' → path is ['http', 'auditBufferSize']", () => {
      try {
        fromEnv({ AGENTDB_HTTP_AUDIT_BUFFER_SIZE: "abc" });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        expect((e as ConfigValidationError).path).toEqual(["http", "auditBufferSize"]);
        expect((e as ConfigValidationError).source).toBe("env");
        return;
      }
      throw new Error("Expected error not thrown");
    });

    it("AGENTDB_GROUP_COMMIT_MS='not-a-number' → throws with source 'env'", () => {
      try {
        fromEnv({ AGENTDB_GROUP_COMMIT_MS: "not-a-number" });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        expect((e as ConfigValidationError).source).toBe("env");
        expect((e as ConfigValidationError).message).toMatch(/not-a-number/);
        return;
      }
      throw new Error("Expected error not thrown");
    });

    it("AGENTDB_MAX_FIND_LIMIT='abc' → throws ConfigValidationError mentioning the var name", () => {
      try {
        fromEnv({ AGENTDB_MAX_FIND_LIMIT: "abc" });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        expect((e as ConfigValidationError).message).toMatch(/AGENTDB_MAX_FIND_LIMIT/);
        return;
      }
      throw new Error("Expected error not thrown");
    });
  });

  describe("enum coercion", () => {
    it("AGENTDB_WRITE_MODE='async' → db.writeMode === 'async'", () => {
      const cfg = fromEnv({ AGENTDB_WRITE_MODE: "async" });
      expect(cfg.db?.writeMode).toBe("async");
    });

    it("AGENTDB_WRITE_MODE='group' → db.writeMode === 'group'", () => {
      const cfg = fromEnv({ AGENTDB_WRITE_MODE: "group" });
      expect(cfg.db?.writeMode).toBe("group");
    });

    it("AGENTDB_WRITE_MODE='immediate' → db.writeMode === 'immediate'", () => {
      const cfg = fromEnv({ AGENTDB_WRITE_MODE: "immediate" });
      expect(cfg.db?.writeMode).toBe("immediate");
    });

    it("AGENTDB_WRITE_MODE='invalid' → throws ConfigValidationError", () => {
      try {
        fromEnv({ AGENTDB_WRITE_MODE: "invalid" });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        expect((e as ConfigValidationError).path).toEqual(["db", "writeMode"]);
        expect((e as ConfigValidationError).source).toBe("env");
        return;
      }
      throw new Error("Expected error not thrown");
    });

    it("AGENTDB_STORAGE_MODE='disk' → db.storageMode === 'disk'", () => {
      const cfg = fromEnv({ AGENTDB_STORAGE_MODE: "disk" });
      expect(cfg.db?.storageMode).toBe("disk");
    });

    it("AGENTDB_STORAGE_MODE='invalid' → throws", () => {
      expect(() => fromEnv({ AGENTDB_STORAGE_MODE: "invalid" })).toThrow(ConfigValidationError);
    });
  });

  describe("string[] coercion (comma-split)", () => {
    it("AGENTDB_HTTP_CORS='https://a.com,https://b.com' → array of two", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_CORS: "https://a.com,https://b.com" });
      expect(cfg.http?.cors).toEqual(["https://a.com", "https://b.com"]);
    });

    it("AGENTDB_HTTP_CORS='*' → array of one ['*']", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_CORS: "*" });
      expect(cfg.http?.cors).toEqual(["*"]);
    });

    it("AGENTDB_SCHEMA_PATHS='./a/*.json,./b/*.json' → array of two", () => {
      const cfg = fromEnv({ AGENTDB_SCHEMA_PATHS: "./a/*.json,./b/*.json" });
      expect(cfg.db?.schemaPaths).toEqual(["./a/*.json", "./b/*.json"]);
    });
  });

  describe("JSON coercion", () => {
    it("AGENTDB_HTTP_MULTI_TOKEN='[\"t1\",\"t2\"]' → array of two strings", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_MULTI_TOKEN: '["t1","t2"]' });
      expect(cfg.http?.multiToken).toEqual(["t1", "t2"]);
    });

    it("AGENTDB_HTTP_MULTI_TOKEN='{not json}' → throws ConfigValidationError", () => {
      try {
        fromEnv({ AGENTDB_HTTP_MULTI_TOKEN: "{not json}" });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        expect((e as ConfigValidationError).path).toEqual(["http", "multiToken"]);
        return;
      }
      throw new Error("Expected error not thrown");
    });

    // B2 carryover: error must NOT echo the raw secret value
    it("AGENTDB_HTTP_MULTI_TOKEN bad JSON — error does NOT contain the raw value (B2 redaction)", () => {
      const secret = '["tok-abc","tok-xyz"]broken';
      try {
        fromEnv({ AGENTDB_HTTP_MULTI_TOKEN: secret });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        const msg = (e as ConfigValidationError).message;
        expect(msg).toContain("AGENTDB_HTTP_MULTI_TOKEN");  // var name is present
        expect(msg).not.toContain("tok-abc");               // raw secret value is NOT present
        expect(msg).toContain("<redacted>");                 // redaction marker is present
        return;
      }
      throw new Error("Expected error not thrown");
    });

    // B3 carryover: JSON parses but wrong shape → post-merge zod catches it
    it("AGENTDB_HTTP_MULTI_TOKEN='[1,2,3]' (number array) → throws ConfigValidationError (wrong shape)", () => {
      try {
        fromEnv({ AGENTDB_HTTP_MULTI_TOKEN: "[1,2,3]" });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        expect((e as ConfigValidationError).source).toBe("env");
        return;
      }
      throw new Error("Expected error not thrown");
    });

    // B3 carryover: valid JSON, correct shape — no error
    it("AGENTDB_HTTP_MULTI_TOKEN='[\"a\",\"b\"]' (string array) → no error (B3 positive)", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_MULTI_TOKEN: '["a","b"]' });
      expect(cfg.http?.multiToken).toEqual(["a", "b"]);
    });
  });

  describe("boolean coercion", () => {
    it("AGENTDB_READ_ONLY='true' → db.readOnly === true", () => {
      const cfg = fromEnv({ AGENTDB_READ_ONLY: "true" });
      expect(cfg.db?.readOnly).toBe(true);
    });

    it("AGENTDB_READ_ONLY='1' → db.readOnly === true", () => {
      const cfg = fromEnv({ AGENTDB_READ_ONLY: "1" });
      expect(cfg.db?.readOnly).toBe(true);
    });

    it("AGENTDB_READ_ONLY='false' → db.readOnly === false", () => {
      const cfg = fromEnv({ AGENTDB_READ_ONLY: "false" });
      expect(cfg.db?.readOnly).toBe(false);
    });

    it("AGENTDB_READ_ONLY='0' → db.readOnly === false", () => {
      const cfg = fromEnv({ AGENTDB_READ_ONLY: "0" });
      expect(cfg.db?.readOnly).toBe(false);
    });

    it("AGENTDB_READ_ONLY='yes' → throws ConfigValidationError", () => {
      expect(() => fromEnv({ AGENTDB_READ_ONLY: "yes" })).toThrow(ConfigValidationError);
    });
  });

  describe("string passthrough", () => {
    it("AGENTDB_PATH='/data/store' → db.path === '/data/store'", () => {
      const cfg = fromEnv({ AGENTDB_PATH: "/data/store" });
      expect(cfg.db?.path).toBe("/data/store");
    });

    it("AGENTDB_HTTP_HOST='0.0.0.0' → http.host === '0.0.0.0'", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_HOST: "0.0.0.0" });
      expect(cfg.http?.host).toBe("0.0.0.0");
    });

    it("AGENTDB_HTTP_AUTH='my-token' → http.auth === 'my-token'", () => {
      const cfg = fromEnv({ AGENTDB_HTTP_AUTH: "my-token" });
      expect(cfg.http?.auth).toBe("my-token");
    });

    it("AGENTDB_EMBEDDINGS_PROVIDER='openai' → db.embeddings.provider === 'openai'", () => {
      const cfg = fromEnv({ AGENTDB_EMBEDDINGS_PROVIDER: "openai" });
      expect(cfg.db?.embeddings?.provider).toBe("openai");
    });
  });

  describe("HNSW nested options", () => {
    it("multiple HNSW env vars populate db.hnsw correctly", () => {
      const cfg = fromEnv({
        AGENTDB_HNSW_M: "8",
        AGENTDB_HNSW_EF_CONSTRUCTION: "150",
        AGENTDB_HNSW_EF_SEARCH: "40",
        AGENTDB_HNSW_MAX_LEVEL: "10",
      });
      expect(cfg.db?.hnsw?.M).toBe(8);
      expect(cfg.db?.hnsw?.efConstruction).toBe(150);
      expect(cfg.db?.hnsw?.efSearch).toBe(40);
      expect(cfg.db?.hnsw?.maxLevel).toBe(10);
    });
  });

  describe("empty env → empty config", () => {
    it("no env vars → empty config (no db/http fields)", () => {
      const cfg = fromEnv({});
      expect(cfg.db).toBeUndefined();
      expect(cfg.http).toBeUndefined();
    });
  });

  describe("empty string env vars are skipped", () => {
    it("AGENTDB_MAX_FIND_LIMIT='' → db.maxFindLimit is undefined (not set)", () => {
      const cfg = fromEnv({ AGENTDB_MAX_FIND_LIMIT: "" });
      expect(cfg.db?.maxFindLimit).toBeUndefined();
    });
  });

  describe("S3 env vars", () => {
    it("AGENTDB_BACKEND and AGENTDB_S3_BUCKET populate db config", () => {
      const cfg = fromEnv({ AGENTDB_BACKEND: "s3", AGENTDB_S3_BUCKET: "my-bucket", AGENTDB_S3_REGION: "us-east-1" });
      expect(cfg.db?.backend).toBe("s3");
      expect(cfg.db?.s3Bucket).toBe("my-bucket");
      expect(cfg.db?.s3Region).toBe("us-east-1");
    });
  });

  describe("JWT env vars", () => {
    it("AGENTDB_HTTP_JWT_SECRET populates http.jwt.secret", () => {
      // Must be ≥32 chars (RFC 7518 §3.2 for HS256).
      const secret = "super-secret-that-is-long-enough1"; // 33 chars
      const cfg = fromEnv({ AGENTDB_HTTP_JWT_SECRET: secret });
      expect(cfg.http?.jwt?.secret).toBe(secret);
    });
  });
});

// ---------------------------------------------------------------------------
// File loading tests (commit 2)
// ---------------------------------------------------------------------------

describe("Config file loading", () => {
  // Each test creates its own unique tmpdir to avoid cross-test pollution.
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = join(tmpdir(), `agentdb-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("valid config file populates db and http fields", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "agentdb.config.json");
    writeFileSync(cfgPath, JSON.stringify({
      db: { maxFindLimit: 50000, memoryBudget: 1073741824, hnsw: { M: 32, efSearch: 100 } },
      http: { port: 3000, maxSessions: 500, auditBufferSize: 50000 },
    }));

    const cfg = loadAgentDBConfig({ configPath: cfgPath, env: {} });
    expect(cfg.db?.maxFindLimit).toBe(50000);
    expect(cfg.db?.memoryBudget).toBe(1073741824);
    expect(cfg.db?.hnsw?.M).toBe(32);
    expect(cfg.db?.hnsw?.efSearch).toBe(100);
    expect(cfg.http?.port).toBe(3000);
    expect(cfg.http?.maxSessions).toBe(500);
    expect(cfg.http?.auditBufferSize).toBe(50000);
  });

  it("missing config file returns empty config — no error", () => {
    const cfg = loadAgentDBConfig({ configPath: "/nonexistent/agentdb.config.json", env: {} });
    expect(cfg.db).toBeUndefined();
    expect(cfg.http).toBeUndefined();
  });

  it("malformed JSON throws ConfigValidationError with file path in message", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "bad.json");
    writeFileSync(cfgPath, "{ not valid json }");

    try {
      loadAgentDBConfig({ configPath: cfgPath, env: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).source).toBe("file");
      expect((e as ConfigValidationError).message).toContain(cfgPath);
      return;
    }
    throw new Error("Expected error not thrown");
  });

  it("invalid shape (db.maxFindLimit as string) throws ConfigValidationError with path", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "invalid.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { maxFindLimit: "not-a-number" } }));

    try {
      loadAgentDBConfig({ configPath: cfgPath, env: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).source).toBe("file");
      expect((e as ConfigValidationError).path).toContain("maxFindLimit");
      return;
    }
    throw new Error("Expected error not thrown");
  });

  it("invalid writeMode in file throws ConfigValidationError", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "bad-mode.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { writeMode: "turbo" } }));

    try {
      loadAgentDBConfig({ configPath: cfgPath, env: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).source).toBe("file");
      return;
    }
    throw new Error("Expected error not thrown");
  });

  it("--config custom path loads from that path", () => {
    const dir = makeTmpDir();
    const customPath = join(dir, "custom.json");
    writeFileSync(customPath, JSON.stringify({ db: { cacheSize: 9999 }, http: { host: "10.0.0.1" } }));

    const cfg = loadAgentDBConfig({ configPath: customPath, env: {} });
    expect(cfg.db?.cacheSize).toBe(9999);
    expect(cfg.http?.host).toBe("10.0.0.1");
  });

  it("config file can contain per-collection overrides", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "col.json");
    writeFileSync(cfgPath, JSON.stringify({
      collections: {
        users: { maxFindLimit: 1000, filterCacheSize: 256 },
        events: { mergeParquetThreshold: 5 },
      },
    }));

    const cfg = loadAgentDBConfig({ configPath: cfgPath, env: {} });
    expect(cfg.collections?.users?.maxFindLimit).toBe(1000);
    expect(cfg.collections?.users?.filterCacheSize).toBe(256);
    expect(cfg.collections?.events?.mergeParquetThreshold).toBe(5);
  });

  it("AGENTDB_CONFIG env var points to config file", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "env-pointed.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { rowGroupSize: 2000 } }));

    // AGENTDB_CONFIG in env (no explicit configPath option → loader reads AGENTDB_CONFIG)
    const cfg = loadAgentDBConfig({ env: { AGENTDB_CONFIG: cfgPath } });
    expect(cfg.db?.rowGroupSize).toBe(2000);
  });

  // -------------------------------------------------------------------------
  // R6/3: World-readable config file warning (POSIX only)
  // -------------------------------------------------------------------------

  it("world-readable config file emits console.warn (POSIX only)", () => {
    if (process.platform === "win32") return;

    const dir = makeTmpDir();
    const cfgPath = join(dir, "world-readable.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { cacheSize: 100 } }));
    chmodSync(cfgPath, 0o644); // world-readable (others can read)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadAgentDBConfig({ configPath: cfgPath, env: {} });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("world-readable"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("non-world-readable config file does not emit console.warn", () => {
    if (process.platform === "win32") return;

    const dir = makeTmpDir();
    const cfgPath = join(dir, "private.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { cacheSize: 100 } }));
    chmodSync(cfgPath, 0o600); // owner-only

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loadAgentDBConfig({ configPath: cfgPath, env: {} });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // R7/2: JWT secret minimum length (RFC 7518 §3.2 — HS256 requires ≥32 bytes)
  // -------------------------------------------------------------------------

  it("R7/2: short JWT secret in config file throws ConfigValidationError with min length message", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "short-secret.json");
    writeFileSync(cfgPath, JSON.stringify({ http: { jwt: { secret: "hunter2" } } }));

    try {
      loadAgentDBConfig({ configPath: cfgPath, env: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      // Error message must mention 32 so operators know the minimum length requirement.
      expect((e as ConfigValidationError).message).toContain("32");
      expect((e as ConfigValidationError).source).toBe("file");
      return;
    }
    throw new Error("Expected ConfigValidationError not thrown");
  });

  it("R7/2: short JWT secret via env var throws ConfigValidationError", () => {
    // The merged-config validation runs ConfigFileSchema.safeParse() after all three layers
    // are merged, so a short AGENTDB_HTTP_JWT_SECRET also gets rejected.
    try {
      loadAgentDBConfig({ configPath: "/nonexistent/no-file.json", env: { AGENTDB_HTTP_JWT_SECRET: "tooshort" } });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      expect((e as ConfigValidationError).message).toContain("32");
      return;
    }
    throw new Error("Expected ConfigValidationError not thrown");
  });

  it("R7/2: JWT secret of exactly 32 characters is accepted", () => {
    const secret32 = "a".repeat(32); // exactly 32 bytes
    const cfg = loadAgentDBConfig({ configPath: "/nonexistent/no-file.json", env: { AGENTDB_HTTP_JWT_SECRET: secret32 } });
    expect(cfg.http?.jwt?.secret).toBe(secret32);
  });
});

// ---------------------------------------------------------------------------
// Precedence tests (commit 2)
// ---------------------------------------------------------------------------

describe("Config precedence (cli > env > file)", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = join(tmpdir(), `agentdb-prec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("env wins over file: file port=3000, env port=4000 → result is 4000", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "a.json");
    writeFileSync(cfgPath, JSON.stringify({ http: { port: 3000 } }));

    const cfg = loadAgentDBConfig({
      configPath: cfgPath,
      env: { AGENTDB_HTTP_PORT: "4000" },
    });
    expect(cfg.http?.port).toBe(4000);
  });

  it("cli wins over env and file: all three set port → CLI wins", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "b.json");
    writeFileSync(cfgPath, JSON.stringify({ http: { port: 3000 } }));

    const cfg = loadAgentDBConfig({
      configPath: cfgPath,
      env: { AGENTDB_HTTP_PORT: "4000" },
      cli: { http: { port: 5000 } },
    });
    expect(cfg.http?.port).toBe(5000);
  });

  it("file wins when env is absent: file maxFindLimit=9999, no env → 9999", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "c.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { maxFindLimit: 9999 } }));

    const cfg = loadAgentDBConfig({ configPath: cfgPath, env: {} });
    expect(cfg.db?.maxFindLimit).toBe(9999);
  });

  it("deep merge: file hnsw.M=32, env hnsw.efSearch=100 → both present", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "d.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { hnsw: { M: 32, efConstruction: 400 } } }));

    const cfg = loadAgentDBConfig({
      configPath: cfgPath,
      env: { AGENTDB_HNSW_EF_SEARCH: "100" },
    });
    expect(cfg.db?.hnsw?.M).toBe(32);
    expect(cfg.db?.hnsw?.efConstruction).toBe(400);
    expect(cfg.db?.hnsw?.efSearch).toBe(100);
  });

  it("per-collection from file not affected by top-level env override", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "e.json");
    writeFileSync(cfgPath, JSON.stringify({
      db: { maxFindLimit: 10000 },
      collections: { users: { maxFindLimit: 100 } },
    }));

    const cfg = loadAgentDBConfig({
      configPath: cfgPath,
      env: { AGENTDB_MAX_FIND_LIMIT: "50" },
    });
    // Env overrides top-level db.maxFindLimit
    expect(cfg.db?.maxFindLimit).toBe(50);
    // Per-collection is in collections key — env has no per-collection var, so file value persists
    expect(cfg.collections?.users?.maxFindLimit).toBe(100);
  });

  it("cli partial override: cli sets host, file sets port — both present", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "f.json");
    writeFileSync(cfgPath, JSON.stringify({ http: { port: 3000 } }));

    const cfg = loadAgentDBConfig({
      configPath: cfgPath,
      env: {},
      cli: { http: { host: "0.0.0.0" } },
    });
    expect(cfg.http?.port).toBe(3000);
    expect(cfg.http?.host).toBe("0.0.0.0");
  });

  it("three layers all set db.path — CLI wins", () => {
    const dir = makeTmpDir();
    const cfgPath = join(dir, "g.json");
    writeFileSync(cfgPath, JSON.stringify({ db: { path: "/file-path" } }));

    const cfg = loadAgentDBConfig({
      configPath: cfgPath,
      env: { AGENTDB_PATH: "/env-path" },
      cli: { db: { path: "/cli-path" } },
    });
    expect(cfg.db?.path).toBe("/cli-path");
  });
});

// ---------------------------------------------------------------------------
// T10: Parameterised coverage for env vars not exercised by the tests above.
// One data-driven loop per type bucket keeps the test count manageable while
// ensuring a typo in ENV_VAR_MAP (wrong path or kind) is caught.
// ---------------------------------------------------------------------------

describe("T10: parameterised env var coverage", () => {
  // Helper: load config from a single env var with no config file.
  function envOnly(varName: string, value: string) {
    return loadAgentDBConfig({ env: { [varName]: value }, configPath: "/nonexistent/no-file.json" });
  }

  // -------------------------------------------------------------------------
  // Number bucket — untested vars
  // -------------------------------------------------------------------------
  const numberCases: Array<{ varName: string; value: number; get: (c: ReturnType<typeof envOnly>) => number | undefined }> = [
    { varName: "AGENTDB_MAX_INDEX_CARDINALITY", value: 500,   get: (c) => c.db?.maxIndexCardinality },
    { varName: "AGENTDB_DISK_CONCURRENCY",      value: 8,     get: (c) => c.db?.diskConcurrency },
    { varName: "AGENTDB_EMBEDDING_BATCH_SIZE",  value: 64,    get: (c) => c.db?.embeddingBatchSize },
    { varName: "AGENTDB_FILTER_CACHE_SIZE",     value: 128,   get: (c) => c.db?.filterCacheSize },
    { varName: "AGENTDB_MERGE_PARQUET_THRESHOLD", value: 15,  get: (c) => c.db?.mergeParquetThreshold },
    { varName: "AGENTDB_MERGE_JSONL_THRESHOLD", value: 12,    get: (c) => c.db?.mergeJsonlThreshold },
    { varName: "AGENTDB_GROUP_COMMIT_SIZE",     value: 25,    get: (c) => c.db?.groupCommitSize },
    { varName: "AGENTDB_ROW_GROUP_SIZE",        value: 4096,  get: (c) => c.db?.rowGroupSize },
    { varName: "AGENTDB_EMBEDDINGS_BATCH_LIMIT", value: 50,   get: (c) => c.db?.embeddings?.batchLimit },
    { varName: "AGENTDB_EMBEDDINGS_DIMENSIONS", value: 1536,  get: (c) => c.db?.embeddings?.dimensions },
    { varName: "AGENTDB_DISK_THRESHOLD",        value: 5000,  get: (c) => c.db?.diskThreshold },
    { varName: "AGENTDB_HTTP_MAX_SESSIONS",     value: 200,   get: (c) => c.http?.maxSessions },
    { varName: "AGENTDB_HTTP_SESSION_IDLE_MS",  value: 30000, get: (c) => c.http?.sessionIdleMs },
    { varName: "AGENTDB_HTTP_AUDIT_MAX_LIMIT",  value: 5000,  get: (c) => c.http?.auditMaxLimit },
    { varName: "AGENTDB_HTTP_AUDIT_DEFAULT_LIMIT", value: 500, get: (c) => c.http?.auditDefaultLimit },
    { varName: "AGENTDB_HTTP_RATE_LIMIT",       value: 120,   get: (c) => c.http?.rateLimit },
    { varName: "AGENTDB_HTTP_RATE_LIMIT_WINDOW", value: 60000, get: (c) => c.http?.rateLimitWindow },
  ];

  for (const { varName, value, get } of numberCases) {
    it(`${varName}='${value}' coerces to number ${value}`, () => {
      const cfg = envOnly(varName, String(value));
      expect(get(cfg)).toBe(value);
    });
  }

  // -------------------------------------------------------------------------
  // String bucket — untested vars
  // -------------------------------------------------------------------------
  const stringCases: Array<{ varName: string; value: string; get: (c: ReturnType<typeof envOnly>) => string | undefined }> = [
    { varName: "AGENTDB_EMBEDDINGS_API_KEY",  value: "sk-test",           get: (c) => c.db?.embeddings?.apiKey },
    { varName: "AGENTDB_EMBEDDINGS_MODEL",    value: "text-emb-3-small",  get: (c) => c.db?.embeddings?.model },
    { varName: "AGENTDB_EMBEDDINGS_URL",      value: "http://localhost/v1/embed", get: (c) => c.db?.embeddings?.url },
    { varName: "AGENTDB_EMBEDDINGS_BASE_URL", value: "http://ollama:11434", get: (c) => c.db?.embeddings?.baseUrl },
    { varName: "AGENTDB_OLLAMA_URL",          value: "http://ollama:11434", get: (c) => c.db?.embeddings?.baseUrl },
    { varName: "AGENTDB_S3_PREFIX",           value: "prod/agentdb",       get: (c) => c.db?.s3Prefix },
    { varName: "AGENTDB_AGENT_ID",            value: "agent-1",            get: (c) => c.db?.agentId },
    { varName: "AGENTDB_TENANT_ID",           value: "org-abc",            get: (c) => c.db?.tenantId },
    { varName: "AGENTDB_HTTP_JWT_AUDIENCE",   value: "https://api.example.com", get: (c) => c.http?.jwt?.audience },
    { varName: "AGENTDB_HTTP_JWT_ISSUER",     value: "https://auth.example.com", get: (c) => c.http?.jwt?.issuer },
  ];

  for (const { varName, value, get } of stringCases) {
    it(`${varName}='${value}' passes through as string`, () => {
      const cfg = envOnly(varName, value);
      expect(get(cfg)).toBe(value);
    });
  }

  // -------------------------------------------------------------------------
  // Verify a NaN number input still rejects (type safety)
  // -------------------------------------------------------------------------
  it("AGENTDB_MERGE_PARQUET_THRESHOLD='notanumber' → throws ConfigValidationError", () => {
    expect(() => envOnly("AGENTDB_MERGE_PARQUET_THRESHOLD", "notanumber")).toThrow(ConfigValidationError);
  });
});
