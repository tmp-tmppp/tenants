import type { Role } from "../domain/role.js";
import type { PageInput } from "./support.js";
import { identitySyncKey, readPage, tenantCursorKey } from "./support.js";
import type { Store } from "./ports.js";

export interface MyOrganization {
  /** The alias in the identity provider (the value after "chance-organization:" in the sign-in scope): the tenant id. */
  alias: string;
  tenantId: string;
  name: string;
  slug: string;
  role: Role;
  joinedAt: Date;
}

export interface MyOrganizationsPage {
  items: MyOrganization[];
  nextCursor: string | null;
  /** True while the user's identity-sync item is queued: the identity provider may not hold every membership yet. */
  identityPending: boolean;
}

/**
 * The organizations the caller belongs to, oldest membership first. The number of memberships of a user is not
 * bounded, so the list is cursor-paginated like every other list of the service (at most 100 per page).
 */
export class ListMyOrganizations {
  constructor(private readonly store: Store) {}

  async execute(input: PageInput & { userId: string }): Promise<MyOrganizationsPage> {
    const { memberships } = this.store.repositories;
    const page = await readPage(
      input,
      (limit, after) => memberships.listByUser(input.userId, limit, after),
      (row) => ({ at: row.membership.joinedAt, key: row.tenant.id }),
      tenantCursorKey,
    );
    const identityPending = await this.store.isIdentitySyncPending(identitySyncKey("member", input.userId));
    return {
      items: page.items.map(({ membership, tenant }) => ({
        alias: tenant.id,
        tenantId: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        role: membership.role,
        joinedAt: membership.joinedAt,
      })),
      nextCursor: page.nextCursor,
      identityPending,
    };
  }
}
