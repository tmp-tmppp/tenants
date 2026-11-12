import { describe, expect, it } from "vitest";
import { ChangeMemberRole } from "../../src/usecases/change-member-role.js";
import { caller, createCore, storeFailingAtCommit, storeWaitingBeforeTransactions } from "../support/harness.js";

async function tenantWithTwoMembers() {
  const core = createCore();
  const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
  await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("admin-1") });
  const trader = await core.useCases.createInvite.execute({
    tenantId: tenant.id,
    role: "trader",
    maxUses: 5,
    expiresInHours: 24,
    caller: caller("admin-1"),
  });
  await core.useCases.acceptInvite.execute({ code: trader.code, caller: caller("user-1") });
  // The tests are about what a role change writes: start from a queue that the reconciler has emptied.
  await core.identitySync.runOnce();
  core.identity.calls.length = 0;
  return { ...core, tenant };
}

const roleEvents = (state: { outbox: Array<{ type: string; payload: unknown }> }) =>
  state.outbox.filter((row) => row.type === "si.chance.tenants.MemberRoleChanged.v1");

describe("ChangeMemberRole", () => {
  it("promotes a member and writes MemberRoleChanged and a sync item, without an identity call", async () => {
    const { useCases, store, identity, tenant } = await tenantWithTwoMembers();

    const result = await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1", 9) });

    expect(result).toMatchObject({ userId: "user-1", role: "tenant-admin" });
    expect(identity.calls).toEqual([]);
    const state = store.snapshot();
    const changed = roleEvents(state);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.payload).toMatchObject({
      subject: "member/user-1",
      correlationid: "corr-9",
      causationid: "req-9",
      data: { userId: "user-1", oldRole: "trader", newRole: "tenant-admin", changedBy: "admin-1" },
    });
    expect(state.identitySync).toEqual([expect.objectContaining({ key: "member/user-1", version: expect.any(Number), attempts: 0 })]);
    expect(state.memberships.find((m) => m.userId === "user-1")?.role).toBe("tenant-admin");
  });

  it("bumps the version of a sync item that is still queued", async () => {
    const { useCases, store, tenant } = await tenantWithTwoMembers();
    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1") });
    const first = store.snapshot().identitySync.find((row) => row.key === "member/user-1")?.version ?? 0;
    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "trader", caller: caller("admin-1") });

    const rows = store.snapshot().identitySync.filter((row) => row.key === "member/user-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBeGreaterThan(first);
  });

  it("answers an unchanged role without an event, a sync item or an identity call", async () => {
    const { useCases, store, identity, tenant } = await tenantWithTwoMembers();
    const before = store.snapshot();

    const result = await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "trader", caller: caller("admin-1") });

    expect(result.role).toBe("trader");
    expect(store.snapshot()).toEqual(before);
    expect(identity.calls).toEqual([]);
  });

  it("refuses to demote the last tenant admin and writes nothing", async () => {
    const { useCases, store, tenant } = await tenantWithTwoMembers();
    const before = store.snapshot();

    await expect(
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "admin-1", role: "trader", caller: caller("admin-1") }),
    ).rejects.toMatchObject({ kind: "conflict", code: "last_admin" });

    expect(store.snapshot()).toEqual(before);
  });

  it("allows a demotion once there is a second admin", async () => {
    const { useCases, tenant } = await tenantWithTwoMembers();
    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1") });
    await expect(
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "admin-1", role: "trader", caller: caller("user-1") }),
    ).resolves.toMatchObject({ role: "trader" });
  });

  it("answers the second of two identical demotions with 200, without a second event", async () => {
    const { useCases, store, tenant } = await tenantWithTwoMembers();
    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1") });
    const eventsBefore = roleEvents(store.snapshot()).length;

    // Two admins demote the same third admin at the same moment.
    const [first, second] = await Promise.all([
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "trader", caller: caller("admin-1", 21) }),
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "trader", caller: caller("admin-1", 22) }),
    ]);

    expect(first.role).toBe("trader");
    expect(second.role).toBe("trader");
    const events = roleEvents(store.snapshot());
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)?.payload).toMatchObject({ causationid: "req-21", data: { oldRole: "tenant-admin", newRole: "trader" } });
  });

  it("reads the clock after it got its turn, so the times of a change follow the commit order", async () => {
    const { store, deps, clock, tenant } = await tenantWithTwoMembers();
    let release: () => void = () => undefined;
    const turn = new Promise<void>((resolve) => (release = resolve));
    const useCase = new ChangeMemberRole({ ...deps, store: storeWaitingBeforeTransactions(store, turn) });

    // The request waits for its turn (the tenant lock); meanwhile another change commits and the clock moves on.
    const pending = useCase.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1", 31) });
    clock.advanceMs(5000);
    release();
    const updated = await pending;

    expect(updated.updatedAt).toEqual(clock.now());
    const event = roleEvents(store.snapshot()).at(-1);
    expect(event?.payload).toMatchObject({ time: clock.now().toISOString(), data: { changedAt: clock.now().toISOString() } });
    expect(store.snapshot().outbox.at(-1)?.createdAt).toEqual(clock.now());
    expect(store.snapshot().identitySync.find((row) => row.key === "member/user-1")?.updatedAt).toEqual(clock.now());
  });

  it("takes the oldRole of every event from the current row, so the events form an unbroken chain", async () => {
    const { useCases, store, tenant } = await tenantWithTwoMembers();

    // A promotion and a demotion of the same member arrive together; whatever order they are applied in, each event
    // must start from the role the previous one ended with.
    await Promise.all([
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1", 31) }),
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "trader", caller: caller("admin-1", 32) }),
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1", 33) }),
    ]);

    const chain = roleEvents(store.snapshot()).map((row) => (row.payload as { data: { oldRole: string; newRole: string } }).data);
    expect(chain.length).toBeGreaterThanOrEqual(1);
    let role = "trader";
    for (const step of chain) {
      expect(step.oldRole).toBe(role);
      expect(step.newRole).not.toBe(step.oldRole);
      role = step.newRole;
    }
    expect(store.snapshot().memberships.find((m) => m.userId === "user-1")?.role).toBe(role);
  });

  it("lets only one of two admins demote the other", async () => {
    const { useCases, store, tenant } = await tenantWithTwoMembers();
    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1") });

    const results = await Promise.allSettled([
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "admin-1", role: "trader", caller: caller("user-1") }),
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "trader", caller: caller("admin-1") }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ code: "last_admin" }) });
    expect(store.snapshot().memberships.filter((m) => m.role === "tenant-admin")).toHaveLength(1);
  });

  it("answers 404 for an unknown member and for a member of another tenant", async () => {
    const core = await tenantWithTwoMembers();
    await expect(
      core.useCases.changeMemberRole.execute({ tenantId: core.tenant.id, userId: "nobody", role: "trader", caller: caller() }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      core.useCases.changeMemberRole.execute({ tenantId: "00000000-0000-7000-8000-00000000ffff", userId: "user-1", role: "trader", caller: caller() }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("is not affected by an identity provider that is down", async () => {
    const { useCases, store, identity, tenant } = await tenantWithTwoMembers();
    identity.available = false;

    await expect(
      useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller() }),
    ).resolves.toMatchObject({ role: "tenant-admin" });
    await expect(store.isIdentitySyncPending("member/user-1")).resolves.toBe(true);
  });

  it("writes nothing at all when the transaction fails", async () => {
    const { deps, store, identity, tenant } = await tenantWithTwoMembers();
    const before = store.snapshot();
    const change = new ChangeMemberRole({ ...deps, store: storeFailingAtCommit(store) });

    await expect(
      change.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1") }),
    ).rejects.toThrow("database is down");

    expect(store.snapshot()).toEqual(before);
    expect(identity.calls).toEqual([]);
  });
});
