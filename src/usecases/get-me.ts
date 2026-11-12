import type { Membership } from "../domain/membership.js";
import { isRole } from "../domain/role.js";
import type { Role } from "../domain/role.js";
import type { Store } from "./ports.js";
import { identitySyncKey } from "./support.js";

export interface GetMeInput {
  userId: string;
  /** The tenant claim of the presented token, if any. */
  tokenTenantId: string | null;
  /** The effective roles of the presented token (token contract v2: the tenant role comes from its organization's group). */
  tokenRoles: readonly string[];
}

export interface Me {
  userId: string;
  tenantId: string | null;
  role: Role | null;
  tokenTenantId: string | null;
  /** True when the token's tenant or role differs from the database: the UI then refreshes the token. */
  tokenNeedsRefresh: boolean;
  /**
   * True while the identity provider may not match the database yet (the user's identity-sync item is queued):
   * refreshing the token cannot help before this is false.
   */
  identityPending: boolean;
}

/** The membership role a token carries: tenant-admin wins over trader; platform-admin is not a membership role. */
export function tokenMembershipRole(tokenRoles: readonly string[]): Role | null {
  if (tokenRoles.includes("tenant-admin")) return "tenant-admin";
  const trader = tokenRoles.find((role) => role === "trader");
  return isRole(trader) ? trader : null;
}

/**
 * The caller in the context of the token. A user may belong to several tenants, so the membership shown is the one of
 * the token's organization; a token without one shows the user's only membership when there is exactly one (the client
 * that has just joined its first tenant learns that its token is stale), and none when there are none or several.
 */
export class GetMe {
  constructor(private readonly store: Store) {}

  async execute(input: GetMeInput): Promise<Me> {
    const { memberships } = this.store.repositories;
    let membership: Membership | null;
    if (input.tokenTenantId !== null) {
      membership = await memberships.find(input.tokenTenantId, input.userId);
    } else {
      const own = await memberships.listByUser(input.userId, 2, null);
      membership = own.length === 1 ? (own[0]?.membership ?? null) : null;
    }
    const tenantId = membership?.tenantId ?? null;
    const role = membership?.role ?? null;
    const identityPending = await this.store.isIdentitySyncPending(identitySyncKey("member", input.userId));
    return {
      userId: input.userId,
      tenantId,
      role,
      tokenTenantId: input.tokenTenantId,
      tokenNeedsRefresh: tenantId !== input.tokenTenantId || role !== tokenMembershipRole(input.tokenRoles),
      identityPending,
    };
  }
}
