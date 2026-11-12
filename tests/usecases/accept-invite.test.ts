import { describe, expect, it } from "vitest";
import { hashInviteCode } from "../../src/domain/invite.js";
import { AcceptInvite } from "../../src/usecases/accept-invite.js";
import { caller, createCore, storeFailingAtCommit, storeWaitingBeforeTransactions } from "../support/harness.js";

async function tenantWithInvite(options: { maxUses?: number; role?: "trader" | "tenant-admin"; ttl?: number } = {}) {
  const core = createCore();
  const { tenant } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
  const invite = await core.useCases.createInvite.execute({
    tenantId: tenant.id,
    role: options.role ?? "trader",
    maxUses: options.maxUses ?? 1,
    expiresInHours: options.ttl ?? 24,
    caller: caller("admin-1"),
  });
  return { ...core, tenant, invite };
}

const usesOf = (state: { invites: Array<{ codeHash: string; uses: number }> }, code: string) =>
  state.invites.find((row) => row.codeHash === hashInviteCode(code))?.uses;

describe("AcceptInvite", () => {
  it("adds the member, counts the use, writes MemberJoined and a sync item, and calls no identity method", async () => {
    const { useCases, store, identity, tenant, invite } = await tenantWithInvite();

    const result = await useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1", 7) });

    expect(result).toEqual({ tenantId: tenant.id, role: "trader" });
    const state = store.snapshot();
    expect(state.memberships).toEqual([expect.objectContaining({ tenantId: tenant.id, userId: "user-1", role: "trader" })]);
    expect(usesOf(state, invite.code)).toBe(1);
    const joined = state.outbox.find((row) => row.type === "si.chance.tenants.MemberJoined.v1");
    expect(joined).toMatchObject({ aggregateId: "user-1", subject: `chance.tenants.MemberJoined.${tenant.id}` });
    expect(joined?.payload).toMatchObject({ subject: "member/user-1", correlationid: "corr-7", causationid: "req-7" });
    expect(state.identitySync).toContainEqual(expect.objectContaining({ key: "member/user-1", kind: "member", target: "user-1", version: expect.any(Number) }));
    expect(identity.calls).toEqual([]);
  });

  it("reads the clock after it holds the invite lock, so the times of the join follow the commit order", async () => {
    const { deps, store, clock, invite } = await tenantWithInvite();
    let release: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const useCase = new AcceptInvite({ ...deps, store: storeWaitingBeforeTransactions(store, turn) });

    // The request waits for its turn behind another join of the same invite; meanwhile the clock moves on.
    const pending = useCase.execute({ code: invite.code, caller: caller("user-1", 8) });
    await new Promise((resolve) => setImmediate(resolve)); // the checks before the transaction are done, it is waiting
    clock.advanceMs(5000);
    release();
    await pending;

    const state = store.snapshot();
    expect(state.memberships).toEqual([expect.objectContaining({ userId: "user-1", joinedAt: clock.now(), updatedAt: clock.now() })]);
    const joined = state.outbox.find((row) => row.type === "si.chance.tenants.MemberJoined.v1");
    expect(joined?.payload).toMatchObject({ time: clock.now().toISOString(), data: { joinedAt: clock.now().toISOString() } });
    expect(joined?.createdAt).toEqual(clock.now());
  });

  it("answers 200 again for a member of the same tenant without a new event, use or sync item", async () => {
    const { useCases, store, identity, invite } = await tenantWithInvite({ maxUses: 5 });
    const first = await useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") });
    const before = store.snapshot();

    const second = await useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") });

    expect(second).toEqual(first);
    expect(store.snapshot()).toEqual(before);
    expect(identity.calls).toEqual([]);
  });

  it("repeats the answer even when this very user used up the invite", async () => {
    const { useCases, invite } = await tenantWithInvite({ maxUses: 1 });
    await useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") });
    await expect(useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") })).resolves.toMatchObject({ role: "trader" });
  });

  it("answers the same user's two simultaneous requests with one membership and one event", async () => {
    const { useCases, store, tenant, invite } = await tenantWithInvite({ maxUses: 1 });

    const results = await Promise.all([
      useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1", 1) }),
      useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1", 2) }),
    ]);

    // The second request finds the single-use invite used up, but by the same user: it is answered as a repeat.
    expect(results).toEqual([
      { tenantId: tenant.id, role: "trader" },
      { tenantId: tenant.id, role: "trader" },
    ]);
    const state = store.snapshot();
    expect(state.memberships).toHaveLength(1);
    expect(usesOf(state, invite.code)).toBe(1);
    expect(state.outbox.filter((row) => row.type.endsWith("MemberJoined.v1"))).toHaveLength(1);
    expect(state.identitySync.filter((row) => row.key === "member/user-1")).toHaveLength(1);
  });

  it("lets only one of two users win a single-use invite", async () => {
    const { useCases, store, invite } = await tenantWithInvite({ maxUses: 1 });

    const results = await Promise.allSettled([
      useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") }),
      useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-2") }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ kind: "gone", code: "invite_used_up" }),
    });
    const state = store.snapshot();
    expect(state.memberships).toHaveLength(1);
    expect(usesOf(state, invite.code)).toBe(1);
    // Only the winner has a sync item and an event.
    expect(state.identitySync.filter((row) => row.kind === "member")).toHaveLength(1);
    expect(state.outbox.filter((row) => row.type.endsWith("MemberJoined.v1"))).toHaveLength(1);
  });

  it("lets a member of another tenant join one more: one membership per tenant, each with its own role and event", async () => {
    const core = await tenantWithInvite({ maxUses: 5 });
    const other = await core.useCases.createTenant.execute({ name: "Other", slug: "other", caller: caller("platform-1") });
    await core.useCases.acceptInvite.execute({ code: other.adminInvite.code, caller: caller("user-1") });

    const result = await core.useCases.acceptInvite.execute({ code: core.invite.code, caller: caller("user-1") });

    expect(result).toEqual({ tenantId: core.tenant.id, role: "trader" });
    const state = core.store.snapshot();
    expect(state.memberships.map((row) => [row.tenantId, row.userId, row.role]).sort()).toEqual(
      [
        [other.tenant.id, "user-1", "tenant-admin"],
        [core.tenant.id, "user-1", "trader"],
      ].sort(),
    );
    expect(usesOf(state, core.invite.code)).toBe(1);
    expect(state.outbox.filter((row) => row.type.endsWith("MemberJoined.v1"))).toHaveLength(2);
    // One sync item per user reconciles all of the user's memberships.
    expect(state.identitySync.filter((row) => row.key === "member/user-1")).toHaveLength(1);
    expect(core.identity.calls).toEqual([]);
  });

  it("leaves the role of an existing membership alone when a second invite of the same tenant gives another role", async () => {
    const core = await tenantWithInvite({ maxUses: 5 });
    const admin = await core.useCases.createInvite.execute({ tenantId: core.tenant.id, role: "tenant-admin", maxUses: 5, expiresInHours: 24, caller: caller("admin-1") });
    await core.useCases.acceptInvite.execute({ code: core.invite.code, caller: caller("user-1") });
    const before = core.store.snapshot();

    await expect(core.useCases.acceptInvite.execute({ code: admin.code, caller: caller("user-1") })).resolves.toEqual({ tenantId: core.tenant.id, role: "trader" });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("answers the existing membership when the user joined the same tenant after the first check", async () => {
    const core = await tenantWithInvite({ maxUses: 5 });
    const second = await core.useCases.createInvite.execute({ tenantId: core.tenant.id, role: "tenant-admin", maxUses: 5, expiresInHours: 24, caller: caller("admin-1") });
    // The user looks free at the first check; another request makes the user a member of this tenant before the
    // transaction, so the primary key (tenant, user) refuses the second membership and the transaction is rolled back.
    const memberships = core.store.repositories.memberships;
    const original = memberships.find.bind(memberships);
    let first = true;
    memberships.find = async (tenantId, userId) => {
      if (first) {
        first = false;
        await core.useCases.acceptInvite.execute({ code: second.code, caller: caller(userId) });
        return null;
      }
      return original(tenantId, userId);
    };

    const result = await core.useCases.acceptInvite.execute({ code: core.invite.code, caller: caller("user-1") });

    expect(result).toEqual({ tenantId: core.tenant.id, role: "tenant-admin" });
    const state = core.store.snapshot();
    expect(state.memberships).toEqual([expect.objectContaining({ tenantId: core.tenant.id, userId: "user-1", role: "tenant-admin" })]);
    expect(usesOf(state, core.invite.code)).toBe(0);
    expect(state.outbox.filter((row) => row.type.endsWith("MemberJoined.v1"))).toHaveLength(1);
  });

  it("does not hide a failure that is not a repeat join: a failing transaction still fails", async () => {
    const { deps, invite, store } = await tenantWithInvite({ maxUses: 5 });
    const accept = new AcceptInvite({ ...deps, store: storeFailingAtCommit(store) });

    await expect(accept.execute({ code: invite.code, caller: caller("user-9") })).rejects.toThrow("database is down");
  });

  it("answers 404 for an unknown code", async () => {
    const { useCases } = await tenantWithInvite();
    await expect(useCases.acceptInvite.execute({ code: "no-such-code-0000000", caller: caller("user-1") })).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("answers 410 for an expired invite and writes nothing", async () => {
    const { useCases, store, clock, invite } = await tenantWithInvite({ ttl: 1 });
    clock.advanceHours(1);
    const before = store.snapshot();

    await expect(useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") })).rejects.toMatchObject({
      kind: "gone",
      code: "invite_expired",
    });
    expect(store.snapshot()).toEqual(before);
  });

  it("answers 410 for an invite that is used up", async () => {
    const { useCases, invite } = await tenantWithInvite({ maxUses: 1 });
    await useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") });

    await expect(useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-2") })).rejects.toMatchObject({
      kind: "gone",
      code: "invite_used_up",
    });
  });

  it("writes nothing at all when the transaction fails, and leaves nothing to undo in the identity provider", async () => {
    const { deps, store, identity, invite } = await tenantWithInvite();
    const before = store.snapshot();
    const accept = new AcceptInvite({ ...deps, store: storeFailingAtCommit(store) });

    await expect(accept.execute({ code: invite.code, caller: caller("user-1") })).rejects.toThrow("database is down");

    expect(store.snapshot()).toEqual(before);
    expect(identity.calls).toEqual([]);
  });

  it("is not affected by an identity provider that is down: the user joins and the sync item waits", async () => {
    const { useCases, store, identity, invite } = await tenantWithInvite();
    identity.available = false;

    await expect(useCases.acceptInvite.execute({ code: invite.code, caller: caller("user-1") })).resolves.toMatchObject({ role: "trader" });

    expect(store.snapshot().memberships).toHaveLength(1);
    await expect(store.isIdentitySyncPending("member/user-1")).resolves.toBe(true);
  });

  it("gives an admin invite the tenant-admin role, which the reconciler later gives to the user", async () => {
    const core = await tenantWithInvite();
    const { adminInvite, tenant } = await core.useCases.createTenant.execute({ name: "Zed", slug: "zed", caller: caller("platform-1") });
    const result = await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("founder") });
    expect(result).toEqual({ tenantId: tenant.id, role: "tenant-admin" });
    expect(core.identity.roleOf(tenant.id, "founder")).toBeUndefined();

    await core.reconcile.execute({ kind: "member", target: "founder" });

    expect(core.identity.roleOf(tenant.id, "founder")).toBe("tenant-admin");
  });
});
