/** Permission levels for an agent. */
export interface AgentPermissions {
  read: boolean;
  write: boolean;
  admin: boolean;
}

/** Default permissions: full access. */
const DEFAULT_PERMISSIONS: AgentPermissions = { read: true, write: true, admin: true };

/**
 * Permission manager for per-agent access control.
 * Honor-system: agents self-report identity via the `agent` field.
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
    const perms = this.rules.get(agent) ?? DEFAULT_PERMISSIONS;
    return perms[level];
  }

  /** Assert a permission, throw if denied. */
  require(agent: string | undefined, level: "read" | "write" | "admin", operation: string): void {
    if (!this.check(agent, level)) {
      throw new Error(`Permission denied: agent '${agent}' does not have '${level}' access for ${operation}`);
    }
  }

  /** Whether any rules are configured. */
  get hasRules(): boolean {
    return this.rules.size > 0;
  }
}
