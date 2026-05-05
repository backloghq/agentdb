/**
 * Unit tests for src/config.ts — env var coercion (commit 1).
 * File loading and precedence tests are in commit 2.
 */
import { describe, it, expect } from "vitest";
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
      const cfg = fromEnv({ AGENTDB_HTTP_JWT_SECRET: "super-secret" });
      expect(cfg.http?.jwt?.secret).toBe("super-secret");
    });
  });
});
