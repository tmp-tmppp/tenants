import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/adapters/memory/memory-store.js";
import { newMembership } from "../../src/domain/membership.js";
import { newTenant } from "../../src/domain/tenant.js";
import { ValidationFailed } from "../../src/usecases/errors.js";
import { tokenMembershipRole } from "../../src/usecases/get-me.js";
import { decodeCursor, encodeCursor, memberCursorKey, tenantCursorKey } from "../../src/usecases/support.js";
import { caller, createCore } from "../support/harness.js";

const TENANT_ID = "00000000-0000-7000-8000-000000000001";
const AT = "2026-11-01T10:00:00.000Z";
/** A cursor as a client could build it by hand. */
const craft = (content: unknown): string => Buffer.from(JSON.stringify(content), "utf8").toString("base64url");

describe("ListTenants", () => {
  async function fiveTenants() {
    const core = createCore();
    for (const slug of ["alpha", "bravo", "charlie", "delta", "echo"]) {
      core.clock.tick();
      await core.useCases.createTenant.execute({ name: slug.toUpperCase(), slug, caller: caller("platform-1") });
    }
    return core;
  }

  it("pages through all tenants, oldest first, with an opaque cursor", async () => {
    const { useCases } = await fiveTenants();

    const first = await useCases.listTenants.execute({ limit: 2 });
    expect(first.items.map((t) => t.slug)).toEqual(["alpha", "bravo"]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await useCases.listTenants.execute({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((t) => t.slug)).toEqual(["charlie", "delta"]);

    const third = await useCases.listTenants.execute({ limit: 2, cursor: second.nextCursor ?? undefined });
    expect(third.items.map((t) => t.slug)).toEqual(["echo"]);
    expect(third.nextCursor).toBeNull();
  });

  it("uses a default page size of 20 and no cursor on a short list", async () => {
    const { useCases } = await fiveTenants();
    const page = await useCases.listTenants.execute({});
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a limit outside 1..100 and a malformed cursor", async () => {
    const { useCases } = await fiveTenants();
    await expect(useCases.listTenants.execute({ limit: 0 })).rejects.toMatchObject({ kind: "validation", fields: [{ field: "limit" }] });
    await expect(useCases.listTenants.execute({ limit: 101 })).rejects.toMatchObject({ kind: "validation" });
    await expect(useCases.listTenants.execute({ cursor: "not-a-cursor" })).rejects.toMatchObject({
      kind: "validation",
      fields: [{ field: "cursor" }],
    });
  });

  it("round-trips a cursor", () => {
    const position = { at: new Date("2026-11-01T10:00:00.123Z"), key: TENANT_ID };
    expect(decodeCursor(encodeCursor(position), tenantCursorKey)).toEqual(position);
    expect(decodeCursor(undefined, tenantCursorKey)).toBeNull();
    expect(() => decodeCursor(craft({ a: "nope", k: 1 }), tenantCursorKey)).toThrowError(ValidationFailed);
  });

  it("accepts the two ends of the allowed time range", () => {
    for (const at of ["1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
      expect(decodeCursor(craft({ a: at, k: TENANT_ID }), tenantCursorKey)).toEqual({ at: new Date(at), key: TENANT_ID });
    }
  });

  it.each([
    ["a time that is no date", { a: "yesterday", k: TENANT_ID }],
    ["a time before 1970", { a: "1969-12-31T23:59:59.999Z", k: TENANT_ID }],
    ["year 0", { a: "0000-01-01T00:00:00.000Z", k: TENANT_ID }],
    ["a negative year", { a: "-000001-01-01T00:00:00.000Z", k: TENANT_ID }],
    ["the largest date JavaScript knows", { a: "+275760-09-13T00:00:00.000Z", k: TENANT_ID }],
    ["year 10000", { a: "+010000-01-01T00:00:00.000Z", k: TENANT_ID }],
    ["February 30", { a: "2026-02-30T00:00:00.000Z", k: TENANT_ID }],
    ["a time without milliseconds", { a: "2026-11-01T10:00:00Z", k: TENANT_ID }],
    ["a time with an offset", { a: "2026-11-01T10:00:00.000+01:00", k: TENANT_ID }],
    ["a number as time", { a: 1_700_000_000_000, k: TENANT_ID }],
    ["no time", { k: TENANT_ID }],
    ["no key", { a: "2026-11-01T10:00:00.000Z" }],
    ["a number as key", { a: "2026-11-01T10:00:00.000Z", k: 7 }],
    ["JSON null", null],
    ["a JSON array", ["2026-11-01T10:00:00.000Z", TENANT_ID]],
  ])("rejects a cursor with %s in both lists", (_label, content) => {
    const cursor = craft(content);
    expect(() => decodeCursor(cursor, tenantCursorKey)).toThrowError(ValidationFailed);
    expect(() => decodeCursor(cursor, memberCursorKey)).toThrowError(ValidationFailed);
  });

  it("accepts only a UUID as key of the tenant list", async () => {
    const { useCases } = await fiveTenants();
    for (const key of ["not-a-uuid", "", "00000000-0000-7000-8000-00000000000g", `${TENANT_ID} `, `${TENANT_ID}\u0000`, "x".repeat(255), "founder"]) {
      await expect(useCases.listTenants.execute({ cursor: craft({ a: AT, k: key }) }), JSON.stringify(key)).rejects.toMatchObject({
        kind: "validation",
        fields: [{ field: "cursor" }],
      });
    }
    await expect(useCases.listTenants.execute({ cursor: craft({ a: AT, k: TENANT_ID.toUpperCase() }) })).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it("accepts a plain user id as key of the member list and refuses empty, long and control-character ones", async () => {
    const core = createCore();
    const { tenant } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const list = (key: string) => core.useCases.listMembers.execute({ tenantId: tenant.id, cursor: craft({ a: AT, k: key }) });
    for (const key of ["x", "user-1", TENANT_ID, "marija.novak@example.com", "č".repeat(255)]) {
      await expect(list(key), JSON.stringify(key)).resolves.toMatchObject({ items: [] });
    }
    for (const key of ["", "x".repeat(256), "a\u0000b", "a\nb", "a\tb", "a\u007fb", "a\u0085b"]) {
      await expect(list(key), JSON.stringify(key)).rejects.toMatchObject({ kind: "validation", fields: [{ field: "cursor" }] });
    }
  });
});

describe("GetMe", () => {
  it("returns no tenant and no role for a user without a membership", async () => {
    const { useCases } = createCore();
    const me = await useCases.getMe.execute({ userId: "user-1", tokenTenantId: null, tokenRoles: [] });
    expect(me).toEqual({ userId: "user-1", tenantId: null, role: null, tokenTenantId: null, tokenNeedsRefresh: false, identityPending: false });
  });

  it("asks for a token refresh right after joining and not once the token has caught up", async () => {
    const core = createCore();
    const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("founder") });

    const stale = await core.useCases.getMe.execute({ userId: "founder", tokenTenantId: null, tokenRoles: [] });
    expect(stale).toMatchObject({ tenantId: tenant.id, role: "tenant-admin", tokenNeedsRefresh: true });

    const staleRole = await core.useCases.getMe.execute({ userId: "founder", tokenTenantId: tenant.id, tokenRoles: ["trader"] });
    expect(staleRole.tokenNeedsRefresh).toBe(true);

    const fresh = await core.useCases.getMe.execute({ userId: "founder", tokenTenantId: tenant.id, tokenRoles: ["tenant-admin"] });
    expect(fresh.tokenNeedsRefresh).toBe(false);
  });

  it("reports identityPending while the user's sync item is queued and not after the reconciler has finished it", async () => {
    const core = createCore();
    const { adminInvite } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("founder") });
    const input = { userId: "founder", tokenTenantId: null, tokenRoles: [] };

    expect((await core.useCases.getMe.execute(input)).identityPending).toBe(true);
    // Another user's pending item does not count.
    expect((await core.useCases.getMe.execute({ ...input, userId: "someone-else" })).identityPending).toBe(false);

    await core.identitySync.runOnce();

    expect((await core.useCases.getMe.execute(input)).identityPending).toBe(false);
  });

  it("does not count platform-admin as a membership role", () => {
    expect(tokenMembershipRole(["platform-admin"])).toBeNull();
    expect(tokenMembershipRole(["platform-admin", "trader"])).toBe("trader");
    expect(tokenMembershipRole(["trader", "tenant-admin"])).toBe("tenant-admin");
  });
});

describe("CreateInvite and ListMembers", () => {
  it("creates invites for an existing tenant only", async () => {
    const { useCases, tenant } = await (async () => {
      const core = createCore();
      const { tenant } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
      return { ...core, tenant };
    })();
    const invite = await useCases.createInvite.execute({ tenantId: tenant.id, role: "trader", maxUses: 3, expiresInHours: 2, caller: caller() });
    expect(invite).toMatchObject({ role: "trader", maxUses: 3, code: expect.any(String) });
    await expect(
      useCases.createInvite.execute({ tenantId: "00000000-0000-7000-8000-00000000ffff", role: "trader", maxUses: 1, expiresInHours: 1, caller: caller() }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      useCases.createInvite.execute({ tenantId: tenant.id, role: "trader", maxUses: 1000, expiresInHours: 1, caller: caller() }),
    ).rejects.toMatchObject({ kind: "validation", fields: [{ field: "maxUses" }] });
  });

  it("lists members in join order with a cursor", async () => {
    const core = createCore();
    const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    const many = await core.useCases.createInvite.execute({ tenantId: tenant.id, role: "trader", maxUses: 10, expiresInHours: 5, caller: caller() });
    await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("founder") });
    for (const user of ["u-1", "u-2", "u-3"]) {
      core.clock.tick();
      await core.useCases.acceptInvite.execute({ code: many.code, caller: caller(user) });
    }

    const first = await core.useCases.listMembers.execute({ tenantId: tenant.id, limit: 3 });
    expect(first.items.map((m) => m.userId)).toEqual(["founder", "u-1", "u-2"]);
    const second = await core.useCases.listMembers.execute({ tenantId: tenant.id, limit: 3, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((m) => m.userId)).toEqual(["u-3"]);
    expect(second.nextCursor).toBeNull();
    await expect(core.useCases.listMembers.execute({ tenantId: "00000000-0000-7000-8000-00000000ffff" })).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("MemoryStore", () => {
  const now = new Date("2026-11-01T10:00:00.000Z");
  const tenant = newTenant({ id: "t-1", name: "Acme", slug: "acme", createdBy: "admin", now });

  it("rolls a failed transaction back completely", async () => {
    const store = new MemoryStore();
    await expect(
      store.transaction(async (repositories) => {
        await repositories.tenants.insert(tenant);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.snapshot().tenants).toEqual([]);
  });

  it("keeps a committed transaction and enforces its unique constraints", async () => {
    const store = new MemoryStore();
    await store.transaction((repositories) => repositories.tenants.insert(tenant));
    await expect(store.transaction((repositories) => repositories.tenants.insert({ ...tenant, id: "t-2" }))).rejects.toMatchObject({ code: "slug_taken" });
    await store.transaction((repositories) => repositories.memberships.insert(newMembership({ tenantId: "t-1", userId: "u-1", role: "trader", now })));
    // One membership per user and tenant: the same pair twice is refused, the same user in a second tenant is not.
    await expect(
      store.transaction((repositories) => repositories.memberships.insert(newMembership({ tenantId: "t-1", userId: "u-1", role: "tenant-admin", now }))),
    ).rejects.toMatchObject({ code: "already_member" });
    await store.transaction((repositories) => repositories.memberships.insert(newMembership({ tenantId: "t-2", userId: "u-1", role: "trader", now })));
    expect(store.snapshot().tenants).toHaveLength(1);
    expect(store.snapshot().memberships).toHaveLength(2);
    await expect(store.ping()).resolves.toBeUndefined();
  });

  it("runs transactions one after another", async () => {
    const store = new MemoryStore();
    const order: string[] = [];
    await Promise.all([
      store.transaction(async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("a-end");
      }),
      store.transaction(() => {
        order.push("b");
        return Promise.resolve();
      }),
    ]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });
});
