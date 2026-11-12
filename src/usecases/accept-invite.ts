import { assertInviteUsable, hashInviteCode } from "../domain/invite.js";
import { memberJoinedEvent } from "../domain/events.js";
import { newMembership } from "../domain/membership.js";
import type { Role } from "../domain/role.js";
import { guardDomain, NotFound } from "./errors.js";
import type { Caller, UseCaseDeps } from "./ports.js";
import { eventContext, outboxMessage } from "./support.js";

export interface AcceptInviteInput {
  code: string;
  caller: Caller;
}

export interface AcceptInviteResult {
  tenantId: string;
  role: Role;
}

/**
 * A user joins the tenant of an invite, also a user who belongs to other tenants already (one membership per user and
 * tenant). The invite is checked first, so the usual refusals cost no transaction.
 * One database transaction then takes the invite row with a lock, checks it again, adds the membership, counts the
 * use and writes the MemberJoined event and an identity-sync item. The identity provider is not called: the
 * reconciler adds the user to the organization and gives the role later (ADR-054), so there is nothing to undo
 * when the transaction fails.
 */
export class AcceptInvite {
  constructor(private readonly deps: UseCaseDeps) {}

  async execute(input: AcceptInviteInput): Promise<AcceptInviteResult> {
    const { store, clock } = this.deps;
    const userId = input.caller.userId;
    const codeHash = hashInviteCode(input.code);

    const invite = await store.repositories.invites.findByHash(codeHash);
    if (!invite) throw new NotFound("invite_not_found", "Invite not found");

    // A member of the same tenant gets the same answer again (a retry after a lost response); this check comes
    // before the validity check, because the invite may have been used up by this very user. A member of other
    // tenants joins one more: one membership per user and tenant, each with its own role.
    const existing = await store.repositories.memberships.find(invite.tenantId, userId);
    if (existing) return { tenantId: existing.tenantId, role: existing.role };
    guardDomain(() => assertInviteUsable(invite, clock.now()));

    try {
      return await store.transaction(async (repositories) => {
        const locked = await repositories.invites.findByHash(codeHash, { lock: true });
        if (!locked) throw new NotFound("invite_not_found", "Invite not found");
        // Read after the invite lock, so that the times of joins of one invite follow the commit order.
        const now = clock.now();
        guardDomain(() => assertInviteUsable(locked, now));
        const membership = newMembership({ tenantId: locked.tenantId, userId, role: locked.role, now });
        await repositories.memberships.insert(membership);
        await repositories.invites.incrementUses(codeHash);
        const event = memberJoinedEvent(membership, eventContext(this.deps, input.caller, now), { via: "invite" });
        await repositories.outbox.add(outboxMessage("MemberJoined", event, userId, now));
        await repositories.identitySync.enqueue("member", userId, now);
        return { tenantId: membership.tenantId, role: membership.role };
      });
    } catch (error) {
      // The same user joined this tenant at the same moment: the other request won, and this transaction was rolled
      // back, either by the primary key (tenant, user) (already_member) or because the other request used up a
      // single-use invite (410). The membership that exists now is answered as a repeat.
      const current = await store.repositories.memberships.find(invite.tenantId, userId).catch(() => null);
      if (current) return { tenantId: current.tenantId, role: current.role };
      throw error;
    }
  }
}
