import { tenantCreatedEvent } from "../domain/events.js";
import { newInvite } from "../domain/invite.js";
import type { Role } from "../domain/role.js";
import { newTenant } from "../domain/tenant.js";
import type { Tenant } from "../domain/tenant.js";
import { Conflict, guardDomain } from "./errors.js";
import type { Caller, UseCaseDeps } from "./ports.js";
import { eventContext, outboxMessage } from "./support.js";

export interface CreateTenantInput {
  name: string;
  slug: string;
  caller: Caller;
}

export interface IssuedInvite {
  /** Shown only here: the service stores its hash. */
  code: string;
  role: Role;
  maxUses: number;
  expiresAt: Date;
}

export interface CreateTenantResult {
  tenant: Tenant;
  adminInvite: IssuedInvite;
}

/**
 * Creates a tenant for a platform admin. One database transaction stores the tenant, a one-time admin invite, the
 * TenantCreated event and an identity-sync item; the identity provider is not called. The reconciler creates the
 * organization later (ADR-054), so a failed request leaves nothing behind in the provider and an outage of the
 * provider does not touch this request.
 */
export class CreateTenant {
  constructor(
    private readonly deps: UseCaseDeps,
    private readonly adminInviteTtlHours: number,
  ) {}

  async execute(input: CreateTenantInput): Promise<CreateTenantResult> {
    const { store, clock, ids } = this.deps;
    const now = clock.now();
    const tenant = guardDomain(() =>
      newTenant({ id: ids.newId(), name: input.name, slug: input.slug, createdBy: input.caller.userId, now }),
    );

    // A quick answer for the usual case; the unique constraint behind the insert decides a race.
    if (await store.repositories.tenants.findBySlug(tenant.slug)) {
      throw new Conflict("slug_taken", `The slug "${tenant.slug}" is already taken`);
    }

    const code = ids.newInviteCode();
    const invite = guardDomain(() =>
      newInvite({
        code,
        tenantId: tenant.id,
        role: "tenant-admin",
        maxUses: 1,
        expiresInHours: this.adminInviteTtlHours,
        createdBy: input.caller.userId,
        now,
      }),
    );
    const event = tenantCreatedEvent(tenant, eventContext(this.deps, input.caller, now));

    await store.transaction(async (repositories) => {
      await repositories.tenants.insert(tenant);
      await repositories.invites.insert(invite);
      await repositories.outbox.add(outboxMessage("TenantCreated", event, tenant.id, now));
      await repositories.identitySync.enqueue("tenant", tenant.id, now);
    });

    return { tenant, adminInvite: { code, role: invite.role, maxUses: invite.maxUses, expiresAt: invite.expiresAt } };
  }
}
