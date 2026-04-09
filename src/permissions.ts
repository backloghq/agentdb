/** Permission levels for an agent. */
export interface AgentPermissions {
  read: boolean;
  write: boolean;
  admin: boolean;
}

/** Default permissions when rules exist: deny all (unknown agents get nothing). */
const DENY_ALL: AgentPermissions = { read: false, write: false, admin: false };

/**
 * Permission manager for per-agent access control.
 * In HTTP mode: agent identity comes from authenticated auth token (secure).
 * In stdio mode: agent identity falls back to self-reported `agent` field (honor-system).
 * When permissions are configured without HTTP auth, enforcement relies on caller honesty.
 */
export class PermissionManager {
  private rules: Map<string, AgentPermissions>;

  constructor(rules?: Record<string, Partial<AgentPermissions>>) {
    this.rules = new Map();
    if (rules) {
      for (const [agent, perms] of Object.entries(rules)) {
        this.rules.set(agent, {
          read: perms.read ?? true,
          write: perms.write ?? false,
          admin: perms.admin ?? false,
        });
      }
    }
  }

  /** Check if an agent has a specific permission. */
  check(agent: string | undefined, level: "read" | "write" | "admin"): boolean {
    if (this.rules.size === 0) return true; // No rules = unrestricted
    if (!agent) return this.rules.size === 0; // No agent + rules configured = denied
    const perms = this.rules.get(agent) ?? DENY_ALL;
    // Permission hierarchy: admin implies write, write implies read
    if (level === "read") return perms.read || perms.write || perms.admin;
    if (level === "write") return perms.write || perms.admin;
    return perms.admin;
  }

  /** Assert a permission, throw if denied. */
  require(agent: string | undefined, level: "read" | "write" | "admin", operation: string): void {
    if (!this.check(agent, level)) {
      throw new Error(`Permission denied: '${level}' access required for ${operation}`);
    }
  }

  /** Whether any rules are configured. */
  get hasRules(): boolean {
    return this.rules.size > 0;
  }
}
