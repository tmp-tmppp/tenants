import { newInvite } from "../domain/invite.js";
import type { Role } from "../domain/role.js";
import { guardDomain, NotFound } from "./errors.js";
import type { Caller, UseCaseDeps } from "./ports.js";
import type { IssuedInvite } from "./create-tenant.js";

export interface CreateInviteInput {
  tenantId: string;
  role: Role;
  maxUses: number;
  expiresInHours: number;
  caller: Caller;
}

export class CreateInvite {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: CreateInviteInput): Promise<IssuedInvite> {
    const { store, clock, ids } = this.deps;
    if (!(await store.repositories.tenants.findById(input.tenantId))) {
      throw new NotFound("tenant_not_found", "Tenant not found");
    }
    const code = ids.newInviteCode();
    const invite = guardDomain(() =>
      newInvite({
        code,
        tenantId: input.tenantId,
        role: input.role,
        maxUses: input.maxUses,
        expiresInHours: input.expiresInHours,
        createdBy: input.caller.userId,
        now: clock.now(),
      }),
    );
    await store.transaction((repositories) => repositories.invites.insert(invite));
    return { code, role: invite.role, maxUses: invite.maxUses, expiresAt: invite.expiresAt };
  }
}
