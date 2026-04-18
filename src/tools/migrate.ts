import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { makeSafe, getAgent, API_NOTE, collectionParam, filterParam, mutationOpts, WRITE, DESTRUCTIVE } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getMigrateTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  return [
    {
      name: "db_migrate",
      title: "Migrate Records",
      description: "Declarative bulk record update via ordered ops: set (always assign), unset (remove), rename (move field, overwrite if target exists), default (assign only if missing), copy (duplicate field without removing source). Ops are applied in order per record. Idempotent ops (default, unset of absent field) make re-running safe. Per-record atomicity — no cross-record transaction. Protected meta-fields (_id, _version, _agent, _reason, _expires, _embedding) are silently skipped. Matching records are snapshotted by ID at migration start — all matches are processed even if ops cause records to leave the filter mid-run. Uses optimistic locking via snapshot versions; concurrent writes to the same record will fail and land in errors[]. Validation fires normally; a schema-violating migration causes per-record failure tracked in errors[]. Throughput: ~22K rec/sec in async write mode, ~1-5K rec/sec in immediate mode (default). For 100K-record migrations, expect 20–100 seconds in default mode." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        ops: z.array(z.union([
          z.object({ op: z.literal("set"), field: z.string().meta({ description: "Field to set" }), value: z.unknown().meta({ description: "Value to assign" }) }),
          z.object({ op: z.literal("unset"), field: z.string().meta({ description: "Field to remove" }) }),
          z.object({ op: z.literal("rename"), from: z.string().meta({ description: "Source field name" }), to: z.string().meta({ description: "Target field name (overwritten if exists)" }) }),
          z.object({ op: z.literal("default"), field: z.string().meta({ description: "Field to set if missing" }), value: z.unknown().meta({ description: "Default value" }) }),
          z.object({ op: z.literal("copy"), from: z.string().meta({ description: "Source field to copy from" }), to: z.string().meta({ description: "Target field to copy into" }) }),
        ])).min(1, "ops must contain at least one operation").max(100, "ops cannot exceed 100 elements").meta({ description: "Ordered list of operations to apply to each record" }),
        filter: filterParam,
        dryRun: z.boolean().optional().default(false).meta({ description: "Preview counts without writing (default: false)" }),
        batchSize: z.number().optional().default(100).meta({ description: "Records per batch (default: 100)" }),
        ...mutationOpts,
      }),
      outputSchema: z.object({
        collection: z.string(),
        scanned: z.number(),
        updated: z.number(),
        unchanged: z.number(),
        failed: z.number(),
        errors: z.array(z.object({ id: z.string(), error: z.string() })),
        dryRun: z.boolean(),
        ops: z.array(z.unknown()),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_migrate", WRITE)(async (args) => {
        const colName = args.collection as string;
        const ops = args.ops as Array<Record<string, unknown>>;
        const filter = args.filter as Record<string, unknown> | string | undefined;
        const dryRun = (args.dryRun as boolean) === true;
        const batchSize = Math.max(1, (args.batchSize as number) || 100);
        const agent = getAgent(args);
        const reason = args.reason as string | undefined;

        if (!ops || ops.length === 0) throw new Error("ops must contain at least one operation");
        if (ops.length > 100) throw new Error("ops cannot exceed 100 elements");

        const PROTECTED = new Set(["_id", "_version", "_agent", "_reason", "_expires", "_embedding", "__proto__", "constructor", "prototype"]);

        function applyOps(record: Record<string, unknown>): Record<string, unknown> {
          const r = { ...record };
          for (const op of ops) {
            switch (op.op) {
              case "set":
                if (!PROTECTED.has(op.field as string)) r[op.field as string] = op.value;
                break;
              case "unset":
                if (!PROTECTED.has(op.field as string)) delete r[op.field as string];
                break;
              case "rename":
                if (!PROTECTED.has(op.from as string) && !PROTECTED.has(op.to as string) && (op.from as string) in r) {
                  r[op.to as string] = r[op.from as string];
                  delete r[op.from as string];
                }
                break;
              case "default":
                if (!PROTECTED.has(op.field as string) && r[op.field as string] === undefined) {
                  r[op.field as string] = op.value;
                }
                break;
              case "copy":
                if (!PROTECTED.has(op.from as string) && !PROTECTED.has(op.to as string) && (op.from as string) in r) {
                  r[op.to as string] = r[op.from as string];
                }
                break;
            }
          }
          return r;
        }

        const col = await db.collection(colName);
        let updated = 0;
        let unchanged = 0;
        let failed = 0;
        const errors: Array<{ id: string; error: string }> = [];

        // Phase 1: snapshot all matching IDs+versions (decouples scan from mutation so
        // records that leave the filter after being processed are still counted)
        const snapshot: Array<{ id: string; version: number | undefined }> = [];
        {
          let snapOffset = 0;
          const SNAP_CHUNK = 5000;
          while (true) {
            const snap = await col.find({ filter, limit: SNAP_CHUNK, offset: snapOffset });
            for (const r of snap.records) {
              snapshot.push({ id: r._id as string, version: r._version as number | undefined });
            }
            if (snap.records.length < SNAP_CHUNK) break;
            snapOffset += SNAP_CHUNK;
          }
        }
        const scanned = snapshot.length;

        // Phase 2: process in batches by ID; use snapshot version for optimistic locking
        for (let batchStart = 0; batchStart < snapshot.length; batchStart += batchSize) {
          const batch = snapshot.slice(batchStart, batchStart + batchSize);
          const batchIds = batch.map(s => s.id);
          const fetched = await col.find({
            filter: { _id: { $in: batchIds } } as import("../collection-helpers.js").Filter,
            limit: batchIds.length,
          });
          const recordMap = new Map(fetched.records.map(r => [r._id as string, r]));

          for (const { id, version: snapVersion } of batch) {
            const record = recordMap.get(id);
            if (!record) {
              failed++;
              if (errors.length < 10) {
                errors.push({ id, error: "record deleted before migration" });
              }
              continue;
            }

            // Apply ops to user fields only (exclude _id for comparison)
            const original: Record<string, unknown> = {};
            const withoutId: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(record)) {
              if (k !== "_id") { original[k] = v; withoutId[k] = v; }
            }
            const migrated = applyOps(withoutId);

            // Diff: only non-protected fields
            const $set: Record<string, unknown> = {};
            const $unset: Record<string, true> = {};
            for (const [k, v] of Object.entries(migrated)) {
              if (PROTECTED.has(k)) continue;
              if (!(k in original) || JSON.stringify(original[k]) !== JSON.stringify(v)) $set[k] = v;
            }
            for (const k of Object.keys(original)) {
              if (PROTECTED.has(k)) continue;
              if (!(k in migrated)) $unset[k] = true;
            }
            const hasChanges = Object.keys($set).length > 0 || Object.keys($unset).length > 0;

            if (!hasChanges) { unchanged++; continue; }

            if (dryRun) { updated++; continue; }

            try {
              const updateOps: Record<string, unknown> = {};
              if (Object.keys($set).length > 0) updateOps.$set = $set;
              if (Object.keys($unset).length > 0) updateOps.$unset = $unset;
              await col.update(
                { _id: id } as import("../collection-helpers.js").Filter,
                updateOps as import("../collection-helpers.js").UpdateOps,
                { agent, reason, expectedVersion: snapVersion },
              );
              updated++;
            } catch (err) {
              failed++;
              if (errors.length < 10) {
                errors.push({ id, error: err instanceof Error ? err.message : String(err) });
              }
            }
          }
        }

        return { collection: colName, scanned, updated, unchanged, failed, errors, dryRun, ops };
      }),
    },
  ];
}
