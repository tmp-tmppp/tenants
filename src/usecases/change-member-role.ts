import { memberRoleChangedEvent } from "../domain/events.js";
import { assertAdminRemains } from "../domain/membership.js";
import type { Membership } from "../domain/membership.js";
import type { Role } from "../domain/role.js";
import { guardDomain, NotFound } from "./errors.js";
import type { Caller, UseCaseDeps } from "./ports.js";
import { eventContext, outboxMessage } from "./support.js";

export interface ChangeMemberRoleInput {
  tenantId: string;
  userId: string;
  role: Role;
  caller: Caller;
}

/**
 * Changes the role of a member in one database transaction; the identity provider is not called (ADR-054): the
 * reconciler gives the user exactly the role of the row later.
 *
 * The transaction first locks the tenant row, a mutex per tenant for role changes, and only then reads the member.
 * The no-op check, the last-admin rule and the oldRole of the event all use that locked, current row, so two
 * changes that arrive together are applied one after the other, each on top of the other's result: a repeated
 * demotion is an unchanged role (200 without an event), and two admins cannot demote each other. The clock is read
 * after the lock, so the times of the rows and events follow the commit order.
 */
export class ChangeMemberRole {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: ChangeMemberRoleInput): Promise<Membership> {
    const { store, clock } = this.deps;

    return store.transaction(async (repositories) => {
      const tenant = await repositories.tenants.findById(input.tenantId, { lock: true });
      if (!tenant) throw new NotFound("member_not_found", "Member not found");
      const current = await repositories.memberships.find(input.tenantId, input.userId);
      if (!current) throw new NotFound("member_not_found", "Member not found");
      if (current.role === input.role) return current;

      const admins = await repositories.memberships.countAdmins(input.tenantId);
      guardDomain(() => assertAdminRemains(current.role, input.role, admins));

      // The time is read here, after the tenant lock: changes of one tenant run one after the other, so their times
      // (updatedAt, changedAt, the event time) follow the order in which they commit. A time read before the wait
      // for the lock could be older than that of the change that went first.
      const now = clock.now();
      const event = memberRoleChangedEvent(
        {
          tenantId: input.tenantId,
          userId: input.userId,
          oldRole: current.role,
          newRole: input.role,
          changedBy: input.caller.userId,
          changedAt: now,
        },
        eventContext(this.deps, input.caller, now),
      );
      const updated = await repositories.memberships.updateRole(input.tenantId, input.userId, input.role, now);
      await repositories.outbox.add(outboxMessage("MemberRoleChanged", event, input.userId, now));
      await repositories.identitySync.enqueue("member", input.userId, now);
      return updated;
    });
  }
}
