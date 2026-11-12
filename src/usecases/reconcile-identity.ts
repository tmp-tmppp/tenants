import type { IdentityProvider, IdentitySyncItem, Keyset, Store, UserOrganization } from "./ports.js";

export interface ReconcileDeps {
  store: Store;
  identity: IdentityProvider;
}

/** Memberships read per page when a user's organizations are reconciled. */
const PAGE = 50;

/**
 * Makes the identity provider match the database for one queued item (ADR-054). It reads the current rows, never
 * the state at the time the item was queued, and calls only idempotent provider methods, so repeating an item one
 * after the other, or running an old item after a newer change, is safe. Two runs for the same key at the same time
 * are not: each reads the rows and then writes the provider, so the run that read the older row can write last and
 * leave the user with the wrong role. The queue prevents it: a claim leases the item and an enqueue does not release
 * the lease (ADR-054).
 *
 * - tenant: if the tenant exists, its organization exists and holds its two groups "tenant-admin" and "trader".
 * - member: for every membership of the user, the user is a member of that tenant's organization and is in exactly the
 *   group of the role of that row (token contract v2: roles are organization groups, never realm roles). The item is
 *   per user, so a user with several memberships is reconciled in one run, and the lease of the queue keeps two runs
 *   for the same user from overlapping. Without a membership there is nothing to do.
 *
 * A failure of the provider is thrown as it is (IdentityProviderUnavailable or IdentityProviderRejected); the
 * worker decides when to try again.
 */
export class ReconcileIdentity {
  constructor(private readonly deps: ReconcileDeps) {}

  async execute(item: Pick<IdentitySyncItem, "kind" | "target">): Promise<void> {
    const { store, identity } = this.deps;
    if (item.kind === "tenant") {
      const tenant = await store.repositories.tenants.findById(item.target);
      if (tenant) await identity.ensureOrganization(tenant.id, tenant.name);
      return;
    }

    // One pass over all memberships of the user, page by page; each organization is made right on its own, so a user
    // who belongs to several organizations gets each one's group and no organization's calls touch another's.
    let after: Keyset | null = null;
    for (;;) {
      const page: UserOrganization[] = await store.repositories.memberships.listByUser(item.target, PAGE, after);
      for (const { membership, tenant } of page) {
        // The membership points to its tenant by a foreign key, so the tenant exists.
        await identity.ensureOrganization(tenant.id, tenant.name);
        await identity.addMember(tenant.id, membership.userId);
        await identity.setRole(tenant.id, membership.userId, membership.role);
      }
      const last = page[page.length - 1];
      if (page.length < PAGE || !last) return;
      after = { at: last.membership.joinedAt, key: last.tenant.id };
    }
  }
}
