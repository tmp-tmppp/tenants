import { DomainError } from "./errors.js";
import type { Role } from "./role.js";

export interface Membership {
  readonly tenantId: string;
  /** Subject of the identity provider. A user belongs to one tenant only. */
  readonly userId: string;
  readonly role: Role;
  readonly joinedAt: Date;
  readonly updatedAt: Date;
}

export function newMembership(input: { tenantId: string; userId: string; role: Role; now: Date }): Membership {
  return { tenantId: input.tenantId, userId: input.userId, role: input.role, joinedAt: input.now, updatedAt: input.now };
}

/** A tenant must always keep at least one tenant admin: demoting the last one is refused. */
export function assertAdminRemains(currentRole: Role, newRole: Role, adminCount: number): void {
  if (currentRole === "tenant-admin" && newRole !== "tenant-admin" && adminCount <= 1) {
    throw new DomainError("last_admin", "The tenant would be left without a tenant admin", "role");
  }
}
