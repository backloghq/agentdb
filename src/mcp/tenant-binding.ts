/**
 * Tenant-binding helpers shared between the CLI bootstrap and tests.
 *
 * Lives in its own module so callers (tests, downstream control plane) can
 * import the validator without executing `cli.ts`'s top-level `main()`.
 */

const MAX_TENANT_ID_LENGTH = 256;

/**
 * Validate the shape of `AGENTDB_TENANT_ID` / `--tenant-id`. Misconfiguration
 * must crash the pod immediately (CrashLoopBackOff) so the control plane sees
 * a provisioning failure rather than a silently-broken process that fails on
 * first request.
 */
export function validateTenantId(value: string): void {
  if (value.length === 0) {
    throw new Error("AGENTDB_TENANT_ID / --tenant-id must be a non-empty string");
  }
  if (value.length > MAX_TENANT_ID_LENGTH) {
    throw new Error(`AGENTDB_TENANT_ID / --tenant-id exceeds ${MAX_TENANT_ID_LENGTH} characters`);
  }
  if (value !== value.trim()) {
    throw new Error("AGENTDB_TENANT_ID / --tenant-id must not contain leading or trailing whitespace");
  }
}
