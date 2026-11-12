import { memberJoinedEvent } from "../domain/events.js";
import { newMembership } from "../domain/membership.js";
import type { Role } from "../domain/role.js";
import { DependencyUnavailable, Forbidden, NotFound } from "./errors.js";
import type { Caller, ShareAdmission, UseCaseDeps } from "./ports.js";
import { eventContext, outboxMessage } from "./support.js";

export interface ShareJoinInput {
  /** The share-link token: a secret. It goes to markets in a request body and nowhere else: not into a log, an error or an event. */
  token: string;
  /** The e-mail claims of the caller's token. */
  email: string | null;
  emailVerified: boolean;
  caller: Caller;
}

export interface ShareJoinResult {
  /** The alias of the organization in the identity provider: the tenant id. */
  alias: string;
  tenantId: string;
  name: string;
  marketId: string;
  role: Role;
  /** True when this call added the membership. */
  joined: boolean;
}

/** The role a share link gives: the link lets people trade, it never makes anyone an admin. */
const SHARE_JOIN_ROLE: Role = "trader";

/**
 * A signed-in user presents a share link (POST /v1/share-joins). Markets decides what the link lets the caller do
 * (contracts/markets-admission.openapi.yaml); this use case adds the trader membership when the answer is "join".
 * The call to markets is outside any transaction: nothing is held while it waits. Markets cannot be asked or answers
 * something else than the contract: a 503, nothing changed, the caller may repeat. An unknown, expired or revoked token
 * is one 404 for all of them.
 *
 * Idempotent: a caller who already is a member of the market's organization gets that membership back (also for a link
 * meant for members only) and nothing is written. A new membership is stored with its MemberJoined event (via
 * "share_link", the market) and an identity-sync item in one transaction, like an invite.
 */
export class ShareJoin {
  constructor(
    private readonly deps: UseCaseDeps,
    private readonly admission: ShareAdmission,
  ) {}

  async execute(input: ShareJoinInput): Promise<ShareJoinResult> {
    const { store, clock, logger } = this.deps;
    const userId = input.caller.userId;

    const answer = await this.admission.admit({ token: input.token, userEmail: input.email, emailVerified: input.emailVerified });
    if (answer.kind === "unavailable") {
      // The reason never holds the token (the client builds it from statuses and error names).
      logger.warn({ reason: answer.reason }, "Markets could not be asked about a share link");
      throw new DependencyUnavailable("market_service_unavailable", "The market service cannot be asked right now; try again shortly");
    }
    if (answer.kind === "not_found") throw new NotFound("share_link_not_found", "No valid share link has this token");

    const tenant = await store.repositories.tenants.findById(answer.tenantId);
    if (!tenant) {
      // Markets names an organization this registry does not know: the link cannot be used, and the caller learns no more.
      logger.error({ tenantId: answer.tenantId, marketId: answer.marketId }, "A share link names an unknown tenant");
      throw new NotFound("share_link_not_found", "No valid share link has this token");
    }
    const result = (role: Role, joined: boolean): ShareJoinResult => ({
      alias: tenant.id,
      tenantId: tenant.id,
      name: tenant.name,
      marketId: answer.marketId,
      role,
      joined,
    });

    const existing = await store.repositories.memberships.find(tenant.id, userId);
    if (existing) return result(existing.role, false);
    if (answer.decision === "members_only") {
      throw new Forbidden("share_link_members_only", "This link is only for members of the organization");
    }
    if (answer.decision === "denied") {
      throw new Forbidden("share_link_not_permitted", "This link is not meant for this account");
    }

    try {
      await store.transaction(async (repositories) => {
        const now = clock.now();
        const membership = newMembership({ tenantId: tenant.id, userId, role: SHARE_JOIN_ROLE, now });
        await repositories.memberships.insert(membership);
        const event = memberJoinedEvent(membership, eventContext(this.deps, input.caller, now), {
          via: "share_link",
          marketId: answer.marketId,
        });
        await repositories.outbox.add(outboxMessage("MemberJoined", event, userId, now));
        await repositories.identitySync.enqueue("member", userId, now);
      });
      return result(SHARE_JOIN_ROLE, true);
    } catch (error) {
      // The same user joined this organization at the same moment (another request, another link or an invite): the
      // primary key refused the second membership. What exists now is the answer.
      const current = await store.repositories.memberships.find(tenant.id, userId).catch(() => null);
      if (current) return result(current.role, false);
      throw error;
    }
  }
}
