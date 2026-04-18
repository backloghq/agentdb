import { z } from "zod";
import type { AgentDB } from "../agentdb.js";
import { mergePersistedSchemas, validatePersistedSchema } from "../schema.js";
import { makeSafe, getAgent, API_NOTE, collectionParam, mutationOpts, READ, DESTRUCTIVE } from "./shared.js";
import type { AgentTool } from "./shared.js";

export function getSchemaTools(db: AgentDB): AgentTool[] {
  function safe(name: string, annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }) {
    return makeSafe(db, name, annotations);
  }

  return [
    {
      name: "db_schema",
      title: "Inspect Schema",
      description: "Inspect the shape of records in a collection by sampling. Reports field names, types (string, number, boolean, array, object), and example values. Use this to understand the data structure before writing queries or filters." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        sampleSize: z.number().optional().default(50).meta({ description: "Number of records to sample" }),
      }),
      outputSchema: z.object({ fields: z.array(z.object({ name: z.string(), type: z.string(), example: z.unknown() })), sampleCount: z.number() }),
      annotations: READ,
      execute: safe("db_schema", READ)(async (args) => {
        const col = await db.collection(args.collection as string);
        return col.schema(args.sampleSize as number);
      }),
    },

    {
      name: "db_get_schema",
      title: "Get Collection Schema",
      description: "Get the persisted schema for a collection including field definitions, descriptions, instructions, and indexes. Use this to understand what data a collection holds, how fields should be used, and what indexes are available. Returns null if no schema has been defined." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
      }),
      outputSchema: z.object({
        schema: z.unknown().meta({ description: "Persisted schema or null" }),
        hasCodeSchema: z.boolean().meta({ description: "Whether a code-level schema is also active" }),
      }),
      annotations: READ,
      execute: safe("db_get_schema", READ)(async (args) => {
        const name = args.collection as string;
        const schema = await db.loadPersistedSchema(name);
        const hasCodeSchema = db.getSchema(name) !== undefined;
        return { schema: schema ?? null, hasCodeSchema };
      }),
    },

    {
      name: "db_set_schema",
      title: "Set Collection Schema",
      description: "Create or update the persisted schema for a collection. Requires admin permission. The schema defines field types, descriptions, instructions for agents, and index configuration. Partial updates are merged with the existing schema." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        schema: z.object({
          version: z.number().optional().meta({ description: "Schema version number" }),
          description: z.string().optional().meta({ description: "What this collection is for" }),
          instructions: z.string().optional().meta({ description: "Instructions for agents on how to use this collection" }),
          fields: z.record(z.string(), z.object({
            type: z.enum(["string", "number", "boolean", "date", "enum", "string[]", "number[]", "object", "autoIncrement"]).meta({ description: "Field data type" }),
            required: z.boolean().optional().meta({ description: "Field is required on insert" }),
            default: z.unknown().optional().meta({ description: "Default value when not provided" }),
            values: z.array(z.string()).optional().meta({ description: "Allowed values for enum type" }),
            maxLength: z.number().optional().meta({ description: "Max string length" }),
            min: z.number().optional().meta({ description: "Min for numbers" }),
            max: z.number().optional().meta({ description: "Max for numbers" }),
            description: z.string().optional().meta({ description: "Human-readable field description for agent discovery" }),
          })).optional().meta({ description: "Field definitions" }),
          indexes: z.array(z.string()).optional().meta({ description: "Fields to create B-tree indexes on" }),
          compositeIndexes: z.array(z.array(z.string())).optional().meta({ description: "Composite indexes" }),
          arrayIndexes: z.array(z.string()).optional().meta({ description: "Array-element indexes for $contains queries" }),
          tagField: z.string().optional().meta({ description: "Array field for +tag/-tag compact filter syntax" }),
          storageMode: z.enum(["memory", "disk", "auto"]).optional().meta({ description: "Storage mode" }),
        }).meta({ description: "Schema definition (partial updates merged with existing)" }),
        ...mutationOpts,
      }),
      outputSchema: z.object({
        schema: z.unknown().meta({ description: "The resulting persisted schema after merge" }),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_set_schema", DESTRUCTIVE)(async (args) => {
        const name = args.collection as string;
        const input = args.schema as Record<string, unknown>;
        const agent = getAgent(args);

        // Build the schema to persist
        const incoming = { name, ...input } as import("../schema.js").PersistedSchema;

        const existing = await db.loadPersistedSchema(name);
        const schema = existing ? mergePersistedSchemas(existing, incoming) : incoming;
        await db.persistSchema(name, schema, { agent });
        return { schema };
      }),
    },

    {
      name: "db_delete_schema",
      title: "Delete Collection Schema",
      description: "Delete the persisted schema for a collection. Requires admin permission. Idempotent — succeeds even if no schema exists. Does not affect the collection's data or in-memory code schema." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        ...mutationOpts,
      }),
      outputSchema: z.object({
        deleted: z.boolean().meta({ description: "True if a schema existed and was removed, false if there was nothing to delete" }),
      }),
      annotations: DESTRUCTIVE,
      execute: safe("db_delete_schema", DESTRUCTIVE)(async (args) => {
        const name = args.collection as string;
        const agent = getAgent(args);
        const existed = (await db.loadPersistedSchema(name)) !== undefined;
        await db.deletePersistedSchema(name, { agent });
        return { deleted: existed };
      }),
    },

    {
      name: "db_diff_schema",
      title: "Diff Schema",
      description: "Preview what db_set_schema would change before committing. Uses the same merge semantics as db_set_schema — partial candidates correctly show no-change for omitted fields. Returns structured diff (added/removed/changed fields and indexes) with warnings about data impact (type changes, required fields, enum removals, tightened constraints). includeImpact:true (default) queries the collection for affected record counts." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        schema: z.object({
          version: z.number().optional().meta({ description: "Schema version number" }),
          description: z.string().optional().meta({ description: "What this collection is for" }),
          instructions: z.string().optional().meta({ description: "Instructions for agents on how to use this collection" }),
          fields: z.record(z.string(), z.object({
            type: z.enum(["string", "number", "boolean", "date", "enum", "string[]", "number[]", "object", "autoIncrement"]).meta({ description: "Field data type" }),
            required: z.boolean().optional().meta({ description: "Field is required on insert" }),
            default: z.unknown().optional().meta({ description: "Default value when not provided" }),
            values: z.array(z.string()).optional().meta({ description: "Allowed values for enum type" }),
            maxLength: z.number().optional().meta({ description: "Max string length" }),
            min: z.number().optional().meta({ description: "Min for numbers" }),
            max: z.number().optional().meta({ description: "Max for numbers" }),
            description: z.string().optional().meta({ description: "Human-readable field description" }),
          })).optional().meta({ description: "Field definitions (partial update — omitted fields are no-change)" }),
          indexes: z.array(z.string()).optional().meta({ description: "B-tree indexes" }),
          compositeIndexes: z.array(z.array(z.string())).optional().meta({ description: "Composite indexes" }),
          arrayIndexes: z.array(z.string()).optional().meta({ description: "Array-element indexes" }),
          tagField: z.string().optional().meta({ description: "Array field for tag compact filter" }),
          storageMode: z.enum(["memory", "disk", "auto"]).optional().meta({ description: "Storage mode" }),
        }).meta({ description: "Candidate schema — same shape as db_set_schema" }),
        includeImpact: z.boolean().optional().default(true).meta({ description: "Query collection for affected record counts (default: true)" }),
      }),
      outputSchema: z.object({
        collection: z.string(),
        hasExisting: z.boolean(),
        added: z.object({
          fields: z.array(z.string()),
          indexes: z.array(z.string()),
          arrayIndexes: z.array(z.string()),
          compositeIndexes: z.array(z.array(z.string())),
        }),
        removed: z.object({
          fields: z.array(z.string()),
          indexes: z.array(z.string()),
          arrayIndexes: z.array(z.string()),
          compositeIndexes: z.array(z.array(z.string())),
        }),
        changed: z.object({
          description: z.object({ from: z.string().nullable(), to: z.string().nullable() }).optional(),
          instructions: z.object({ from: z.string().nullable(), to: z.string().nullable() }).optional(),
          version: z.object({ from: z.number().nullable(), to: z.number().nullable() }).optional(),
          fields: z.record(z.string(), z.record(z.string(), z.unknown())),
        }),
        warnings: z.array(z.object({
          severity: z.enum(["high", "medium", "low"]),
          message: z.string(),
        })),
        impact: z.object({
          totalRecords: z.number(),
          recordsWithRemovedFields: z.number(),
          recordsViolatingNewConstraints: z.number(),
        }).optional(),
      }),
      annotations: READ,
      execute: safe("db_diff_schema", READ)(async (args) => {
        const name = args.collection as string;
        const input = args.schema as Record<string, unknown>;
        const includeImpact = (args.includeImpact as boolean) !== false;

        const existing = await db.loadPersistedSchema(name);
        const hasExisting = existing !== undefined;
        const base: import("../schema.js").PersistedSchema = existing ?? { name };
        const incoming = { name, ...input } as import("../schema.js").PersistedSchema;
        const merged = hasExisting ? mergePersistedSchemas(existing!, incoming) : incoming;

        // Field diff (existing → merged)
        const baseFields = base.fields ?? {};
        const mergedFields = merged.fields ?? {};
        const existingFieldNames = Object.keys(baseFields);
        const mergedFieldNames = Object.keys(mergedFields);
        const addedFields = mergedFieldNames.filter(f => !existingFieldNames.includes(f));
        const removedFields = existingFieldNames.filter(f => !mergedFieldNames.includes(f));

        const changedFields: Record<string, Record<string, unknown>> = {};
        for (const fn of existingFieldNames.filter(f => mergedFieldNames.includes(f))) {
          const ef = baseFields[fn];
          const mf = mergedFields[fn];
          const chg: Record<string, unknown> = {};
          if (ef.type !== mf.type) chg.type = { from: ef.type, to: mf.type };
          const efReq = ef.required ?? false; const mfReq = mf.required ?? false;
          if (efReq !== mfReq) chg.required = { from: efReq, to: mfReq };
          const efDesc = ef.description ?? null; const mfDesc = mf.description ?? null;
          if (efDesc !== mfDesc) chg.description = { from: efDesc, to: mfDesc };
          const efMaxLen = ef.maxLength ?? null; const mfMaxLen = mf.maxLength ?? null;
          if (efMaxLen !== mfMaxLen) chg.maxLength = { from: efMaxLen, to: mfMaxLen };
          const efMin = ef.min ?? null; const mfMin = mf.min ?? null;
          if (efMin !== mfMin) chg.min = { from: efMin, to: mfMin };
          const efMax = ef.max ?? null; const mfMax = mf.max ?? null;
          if (efMax !== mfMax) chg.max = { from: efMax, to: mfMax };
          const efVals = ef.values ?? []; const mfVals = mf.values ?? [];
          const mfValSet = new Set(mfVals);
          const efValSet = new Set(efVals);
          const valsAdded = mfVals.filter(v => !efValSet.has(v));
          const valsRemoved = efVals.filter(v => !mfValSet.has(v));
          if (valsAdded.length > 0 || valsRemoved.length > 0) chg.values = { added: valsAdded, removed: valsRemoved };
          if (JSON.stringify(ef.default ?? null) !== JSON.stringify(mf.default ?? null)) {
            chg.default = { from: ef.default ?? null, to: mf.default ?? null };
          }
          if (Object.keys(chg).length > 0) changedFields[fn] = chg;
        }

        // Index diff
        const baseIdx = base.indexes ?? []; const mergedIdx = merged.indexes ?? [];
        const addedIndexes = mergedIdx.filter(i => !baseIdx.includes(i));
        const removedIndexes = baseIdx.filter(i => !mergedIdx.includes(i));
        const baseArrIdx = base.arrayIndexes ?? []; const mergedArrIdx = merged.arrayIndexes ?? [];
        const addedArrayIndexes = mergedArrIdx.filter(i => !baseArrIdx.includes(i));
        const removedArrayIndexes = baseArrIdx.filter(i => !mergedArrIdx.includes(i));
        const baseCmp = base.compositeIndexes ?? []; const mergedCmp = merged.compositeIndexes ?? [];
        const baseCmpKeys = new Set(baseCmp.map(ci => ci.join(",")));
        const mergedCmpKeys = new Set(mergedCmp.map(ci => ci.join(",")));
        const addedCompositeIndexes = mergedCmp.filter(ci => !baseCmpKeys.has(ci.join(",")));
        const removedCompositeIndexes = baseCmp.filter(ci => !mergedCmpKeys.has(ci.join(",")));

        // Top-level changed
        const changed: Record<string, unknown> = {};
        const bDesc = base.description ?? null; const mDesc = merged.description ?? null;
        if (bDesc !== mDesc) changed.description = { from: bDesc, to: mDesc };
        const bInstr = base.instructions ?? null; const mInstr = merged.instructions ?? null;
        if (bInstr !== mInstr) changed.instructions = { from: bInstr, to: mInstr };
        const bVer = base.version ?? null; const mVer = merged.version ?? null;
        if (bVer !== mVer) changed.version = { from: bVer, to: mVer };
        changed.fields = changedFields;

        // Structural warnings (no counts yet)
        const warnings: Array<{ severity: string; message: string }> = [];
        if (hasExisting && base.description != null && merged.description == null) {
          warnings.push({ severity: "low", message: "Collection description removed" });
        }
        if (hasExisting && base.instructions != null && merged.instructions == null) {
          warnings.push({ severity: "low", message: "Collection instructions removed" });
        }
        for (const fn of removedFields) {
          warnings.push({ severity: "medium", message: `Field '${fn}' removed from schema` });
        }
        for (const [fn, chg] of Object.entries(changedFields)) {
          if (chg.type) {
            const t = chg.type as { from: string; to: string };
            warnings.push({ severity: "high", message: `Field '${fn}' type changed from '${t.from}' to '${t.to}'` });
          }
          if (chg.required) {
            const r = chg.required as { from: boolean; to: boolean };
            if (!r.from && r.to) {
              warnings.push({ severity: "medium", message: `Field '${fn}' is now required — existing records missing this field will fail validation` });
            }
          }
          if (chg.values) {
            const v = chg.values as { added: string[]; removed: string[] };
            if (v.removed.length > 0) {
              warnings.push({ severity: "high", message: `Field '${fn}' enum removed value(s): ${v.removed.join(", ")}` });
            }
          }
          if (chg.maxLength) {
            const ml = chg.maxLength as { from: number | null; to: number | null };
            if (ml.to !== null && (ml.from === null || ml.to < ml.from)) {
              warnings.push({ severity: "medium", message: `Field '${fn}' maxLength tightened${ml.from !== null ? ` from ${ml.from}` : ""} to ${ml.to}` });
            }
          }
          if (chg.min) {
            const mn = chg.min as { from: number | null; to: number | null };
            if (mn.to !== null && (mn.from === null || mn.to > mn.from)) {
              warnings.push({ severity: "medium", message: `Field '${fn}' min tightened${mn.from !== null ? ` from ${mn.from}` : ""} to ${mn.to}` });
            }
          }
          if (chg.max) {
            const mx = chg.max as { from: number | null; to: number | null };
            if (mx.to !== null && (mx.from === null || mx.to < mx.from)) {
              warnings.push({ severity: "medium", message: `Field '${fn}' max tightened${mx.from !== null ? ` from ${mx.from}` : ""} to ${mx.to}` });
            }
          }
          if (chg.description) {
            const d = chg.description as { from: string | null; to: string | null };
            if (d.from !== null && d.to === null) {
              warnings.push({ severity: "low", message: `Field '${fn}' description removed` });
            }
          }
        }

        // Impact scan
        let impact: Record<string, number> | undefined;
        const collectionExists = db.getCollectionNames().includes(name);
        if (!collectionExists) {
          warnings.push({ severity: "medium", message: `Collection '${name}' does not exist yet` });
        }

        if (includeImpact) {
          if (collectionExists) {
            const col = await db.collection(name);
            const totalRecords = await col.count();
            let recordsWithRemovedFields = 0;
            if (removedFields.length > 0 && totalRecords > 0) {
              const orFilter = { $or: removedFields.map(f => ({ [f]: { $exists: true } })) };
              recordsWithRemovedFields = await col.count(orFilter as import("../collection-helpers.js").Filter);
              for (const fn of removedFields) {
                const cnt = await col.count({ [fn]: { $exists: true } });
                if (cnt > 0) {
                  const w = warnings.find(w => w.message === `Field '${fn}' removed from schema`);
                  if (w) w.message += ` (${cnt} records have this field)`;
                }
              }
            }
            let recordsViolatingNewConstraints = 0;
            for (const [fn, chg] of Object.entries(changedFields)) {
              if (chg.type) {
                const cnt = await col.count({ [fn]: { $exists: true } });
                if (cnt > 0) {
                  const w = warnings.find(w => w.severity === "high" && w.message.includes(`Field '${fn}' type changed`));
                  if (w) w.message += ` (${cnt} records affected)`;
                }
              }
              if (chg.required) {
                const r = chg.required as { from: boolean; to: boolean };
                if (!r.from && r.to) {
                  const cnt = await col.count({ [fn]: { $exists: false } });
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' is now required`));
                    if (w) w.message += ` (${cnt} records missing field)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.values) {
                const v = chg.values as { added: string[]; removed: string[] };
                if (v.removed.length > 0) {
                  let cnt = 0;
                  for (const val of v.removed) cnt += await col.count({ [fn]: val });
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "high" && w.message.includes(`Field '${fn}' enum removed`));
                    if (w) w.message += ` (${cnt} records affected)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.maxLength) {
                const ml = chg.maxLength as { from: number | null; to: number | null };
                if (ml.to !== null && (ml.from === null || ml.to < ml.from)) {
                  const cnt = await col.count({ [fn]: { $strLen: { $gt: ml.to } } } as import("../collection-helpers.js").Filter);
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' maxLength tightened`));
                    if (w) w.message += ` (${cnt} records violating)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.min) {
                const mn = chg.min as { from: number | null; to: number | null };
                if (mn.to !== null && (mn.from === null || mn.to > mn.from)) {
                  const cnt = await col.count({ [fn]: { $lt: mn.to } } as import("../collection-helpers.js").Filter);
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' min tightened`));
                    if (w) w.message += ` (${cnt} records violating)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
              if (chg.max) {
                const mx = chg.max as { from: number | null; to: number | null };
                if (mx.to !== null && (mx.from === null || mx.to < mx.from)) {
                  const cnt = await col.count({ [fn]: { $gt: mx.to } } as import("../collection-helpers.js").Filter);
                  if (cnt > 0) {
                    const w = warnings.find(w => w.severity === "medium" && w.message.includes(`Field '${fn}' max tightened`));
                    if (w) w.message += ` (${cnt} records violating)`;
                    recordsViolatingNewConstraints += cnt;
                  }
                }
              }
            }
            impact = { totalRecords, recordsWithRemovedFields, recordsViolatingNewConstraints };
          } else {
            impact = { totalRecords: 0, recordsWithRemovedFields: 0, recordsViolatingNewConstraints: 0 };
          }
        }

        const result: Record<string, unknown> = {
          collection: name,
          hasExisting,
          added: { fields: addedFields, indexes: addedIndexes, arrayIndexes: addedArrayIndexes, compositeIndexes: addedCompositeIndexes },
          removed: { fields: removedFields, indexes: removedIndexes, arrayIndexes: removedArrayIndexes, compositeIndexes: removedCompositeIndexes },
          changed,
          warnings,
        };
        if (impact !== undefined) result.impact = impact;
        return result;
      }),
    },

    {
      name: "db_infer_schema",
      title: "Infer Schema",
      description: "Sample existing records and propose a PersistedSchema — solves the cold-start problem. Detects field types (boolean, number, string, date, enum, string[], number[], object), marks fields required when present in ≥ requiredThreshold fraction of records, and infers enum values when distinct string count ≤ enumThreshold. Mixed-type fields are skipped with a note. Sampling is offset-randomised when totalRecords > sampleSize. The proposed schema passes validatePersistedSchema and can be forwarded directly to db_set_schema. Does not mutate any data." + API_NOTE,
      schema: z.object({
        collection: collectionParam,
        sampleSize: z.number().optional().default(100).meta({ description: "Max records to sample (default: 100, cap: 10000)" }),
        enumThreshold: z.number().optional().default(10).meta({ description: "Max distinct string values before treating as free-text instead of enum (default: 10)" }),
        requiredThreshold: z.number().optional().default(0.95).meta({ description: "Fraction of sampled records a field must appear in to be marked required (default: 0.95)" }),
      }),
      outputSchema: z.object({
        collection: z.string(),
        sampleSize: z.number(),
        totalRecords: z.number(),
        proposed: z.record(z.string(), z.unknown()),
        notes: z.array(z.string()),
      }),
      annotations: READ,
      execute: safe("db_infer_schema", READ)(async (args) => {
        const colName = args.collection as string;
        const sampleSize = Math.min(Math.max(1, (args.sampleSize as number) || 100), 10000);
        const enumThreshold = Math.max(1, (args.enumThreshold as number) || 10);
        const requiredThreshold = Math.max(0, Math.min(1, (args.requiredThreshold as number) ?? 0.95));

        const META = new Set(["_id", "_version", "_agent", "_reason", "_expires", "_embedding", "__proto__", "constructor", "prototype"]);

        const col = await db.collection(colName);
        const totalRecords = await col.count();
        const notes: string[] = [];

        // Warn when a persisted schema already exists
        const existingSchema = await db.loadPersistedSchema(colName);
        if (existingSchema !== undefined) {
          const versionPart = existingSchema.version !== undefined ? ` (version ${existingSchema.version})` : "";
          notes.push(`Collection already has a persisted schema${versionPart}. Use db_diff_schema to compare or db_set_schema to replace.`);
        }

        // Sampling: col.iterate() streaming pass + Algorithm R reservoir sampling.
        // O(sampleSize) memory — disk-backed collections stream records one-at-a-time
        // via the async generator so the full dataset is never accumulated in memory.
        // O(N) time with a single pass through the collection.
        let records: Record<string, unknown>[];
        if (totalRecords === 0) {
          records = [];
        } else {
          // Algorithm R (Vitter 1985): uniform reservoir sampling without replacement.
          // Each position i has exactly k/i probability of being in the final reservoir.
          // Memory: O(sampleSize), Time: O(N) — exactly one pass through the collection.
          const reservoir: Record<string, unknown>[] = [];
          let i = 0;
          for await (const record of col.iterate()) {
            if (i < sampleSize) {
              reservoir.push(record);
            } else {
              const j = Math.floor(Math.random() * (i + 1));
              if (j < sampleSize) reservoir[j] = record;
            }
            i++;
          }
          records = reservoir;
          if (i > sampleSize) {
            notes.push(`Sampled ${reservoir.length} of ${totalRecords} total records (Algorithm R reservoir sampling).`);
          }
        }

        const actualSample = records.length;

        if (actualSample === 0) {
          const proposed: import("../schema.js").PersistedSchema = { name: colName };
          validatePersistedSchema(proposed);
          return { collection: colName, sampleSize: actualSample, totalRecords, proposed, notes: ["Collection is empty; no fields could be inferred."] };
        }

        // Collect field names across all sample records (skip meta)
        const fieldNames = new Set<string>();
        for (const record of records) {
          for (const key of Object.keys(record)) {
            if (!META.has(key)) fieldNames.add(key);
          }
        }

        const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T|Z|$)/;

        const fields: Record<string, import("../schema.js").PersistedFieldDef> = {};

        for (const fieldName of fieldNames) {
          const values = records
            .map(r => r[fieldName])
            .filter(v => v !== undefined && v !== null);

          if (values.length === 0) continue;

          const presentCount = records.filter(r => r[fieldName] !== undefined && r[fieldName] !== null).length;

          // Count how many values fall into each type bucket
          let boolCount = 0, numCount = 0, strCount = 0, strArrCount = 0, numArrCount = 0, objCount = 0, otherCount = 0;
          for (const v of values) {
            if (typeof v === "boolean") boolCount++;
            else if (typeof v === "number") numCount++;
            else if (typeof v === "string") strCount++;
            else if (Array.isArray(v)) {
              if (v.length === 0 || v.every(e => typeof e === "string")) strArrCount++;
              else if (v.every(e => typeof e === "number")) numArrCount++;
              else otherCount++;
            } else if (typeof v === "object") objCount++;
            else otherCount++;
          }

          const activeBuckets = [boolCount, numCount, strCount, strArrCount, numArrCount, objCount, otherCount]
            .filter(c => c > 0).length;

          if (activeBuckets > 1) {
            const typeLabels: string[] = [];
            if (boolCount) typeLabels.push("boolean");
            if (numCount) typeLabels.push("number");
            if (strCount) typeLabels.push("string");
            if (strArrCount) typeLabels.push("string[]");
            if (numArrCount) typeLabels.push("number[]");
            if (objCount) typeLabels.push("object");
            if (otherCount) typeLabels.push("mixed/unknown");
            notes.push(`Field '${fieldName}': mixed types observed (${typeLabels.join(", ")}), skipped.`);
            continue;
          }

          const required = presentCount / actualSample >= requiredThreshold;
          let fieldDef: import("../schema.js").PersistedFieldDef;

          if (boolCount > 0) {
            fieldDef = { type: "boolean" };
          } else if (numCount > 0) {
            fieldDef = { type: "number" };
          } else if (strCount > 0) {
            const strs = values as string[];
            if (strs.every(s => ISO_DATE_RE.test(s))) {
              fieldDef = { type: "date" };
              notes.push(`Field '${fieldName}': inferred as date string.`);
            } else {
              const uniqueValues = new Set(strs);
              if (uniqueValues.size <= enumThreshold) {
                fieldDef = { type: "enum", values: [...uniqueValues].sort() };
                notes.push(`Field '${fieldName}': inferred as enum with ${uniqueValues.size} distinct value(s).`);
              } else {
                const maxLength = Math.max(...strs.map(s => s.length));
                fieldDef = { type: "string", maxLength };
              }
            }
          } else if (strArrCount > 0) {
            fieldDef = { type: "string[]" };
          } else if (numArrCount > 0) {
            fieldDef = { type: "number[]" };
          } else {
            fieldDef = { type: "object" };
          }

          if (required) fieldDef.required = true;
          fields[fieldName] = fieldDef;
        }

        const proposed: import("../schema.js").PersistedSchema = { name: colName };
        if (Object.keys(fields).length > 0) proposed.fields = fields;
        validatePersistedSchema(proposed);

        return { collection: colName, sampleSize: actualSample, totalRecords, proposed, notes };
      }),
    },
  ];
}
