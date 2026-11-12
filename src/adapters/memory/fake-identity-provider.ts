import type { Role } from "../../domain/role.js";
import { IdentityProviderRejected, IdentityProviderUnavailable } from "../../usecases/errors.js";
import type { IdentityProvider } from "../../usecases/ports.js";

/** The two role groups every organization holds, as the Keycloak adapter creates them. */
export const ROLE_GROUPS: readonly Role[] = ["tenant-admin", "trader"];

/** An identity provider that keeps everything in memory: for tests and for local runs without Keycloak. */
export class FakeIdentityProvider implements IdentityProvider {
  readonly organizations = new Map<string, string>();
  /** The role groups each organization holds, by tenant id. */
  readonly groups = new Map<string, Set<Role>>();
  readonly members = new Set<string>();
  /** The group a member is in, by "<tenantId>:<userId>": exactly one per organization, as the real one keeps it. */
  readonly roles = new Map<string, Role>();
  /** Every call as "method:argument:...", in order. */
  readonly calls: string[] = [];
  /** When false, every call fails like an unavailable provider. */
  available = true;
  /** When set, every call fails like a provider that answers with this HTTP status and refuses. */
  rejectWith: number | null = null;

  ensureOrganization(tenantId: string, name: string): Promise<void> {
    return this.run(`ensureOrganization:${tenantId}`, () => {
      this.organizations.set(tenantId, name);
      this.groups.set(tenantId, new Set(ROLE_GROUPS));
    });
  }

  addMember(tenantId: string, userId: string): Promise<void> {
    return this.run(`addMember:${tenantId}:${userId}`, () => {
      this.members.add(`${tenantId}:${userId}`);
    });
  }

  setRole(tenantId: string, userId: string, role: Role): Promise<void> {
    return this.run(`setRole:${tenantId}:${userId}:${role}`, () => {
      this.roles.set(`${tenantId}:${userId}`, role);
    });
  }

  /** The role group of a member in one organization, or undefined. */
  roleOf(tenantId: string, userId: string): Role | undefined {
    return this.roles.get(`${tenantId}:${userId}`);
  }

  private run(call: string, effect: () => void): Promise<void> {
    this.calls.push(call);
    if (!this.available) return Promise.reject(new IdentityProviderUnavailable("The fake identity provider is unavailable"));
    if (this.rejectWith !== null) {
      return Promise.reject(new IdentityProviderRejected(this.rejectWith, `The fake identity provider answered ${this.rejectWith}`));
    }
    effect();
    return Promise.resolve();
  }
}
