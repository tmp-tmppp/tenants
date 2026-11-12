import { describe, expect, it } from "vitest";
import { caller, createCore } from "../support/harness.js";

/** A user who belongs to four organizations: admin of "alpha", trader of "bravo", "charlie" and "delta", joined in this order. */
async function userInFourOrganizations() {
  const core = createCore();
  const tenants: Array<{ id: string; slug: string }> = [];
  for (const [slug, role] of [["alpha", "tenant-admin"], ["bravo", "trader"], ["charlie", "trader"], ["delta", "trader"]] as const) {
    core.clock.tick();
    const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: slug.toUpperCase(), slug, caller: caller("platform-1") });
    core.clock.tick();
    const code =
      role === "tenant-admin"
        ? adminInvite.code
        : (await (async () => {
            await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller(`owner-${slug}`) });
            return core.useCases.createInvite.execute({ tenantId: tenant.id, role, maxUses: 5, expiresInHours: 24, caller: caller(`owner-${slug}`) });
          })()).code;
    await core.useCases.acceptInvite.execute({ code, caller: caller("user-1") });
    tenants.push({ id: tenant.id, slug });
  }
  return { ...core, tenants };
}

describe("ListMyOrganizations", () => {
  it("lists the organizations of the caller, oldest membership first, with the role of each", async () => {
    const { useCases, tenants } = await userInFourOrganizations();

    const page = await useCases.listMyOrganizations.execute({ userId: "user-1" });

    expect(page.items.map((item) => [item.slug, item.role])).toEqual([
      ["alpha", "tenant-admin"],
      ["bravo", "trader"],
      ["charlie", "trader"],
      ["delta", "trader"],
    ]);
    expect(page.items[0]).toMatchObject({ alias: tenants[0]?.id, tenantId: tenants[0]?.id, name: "ALPHA" });
    expect(page.nextCursor).toBeNull();
  });

  it("pages with an opaque cursor and refuses a malformed cursor and a limit outside 1..100", async () => {
    const { useCases } = await userInFourOrganizations();

    const first = await useCases.listMyOrganizations.execute({ userId: "user-1", limit: 3 });
    expect(first.items.map((item) => item.slug)).toEqual(["alpha", "bravo", "charlie"]);
    const second = await useCases.listMyOrganizations.execute({ userId: "user-1", limit: 3, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((item) => item.slug)).toEqual(["delta"]);
    expect(second.nextCursor).toBeNull();

    await expect(useCases.listMyOrganizations.execute({ userId: "user-1", cursor: "not-a-cursor" })).rejects.toMatchObject({ kind: "validation" });
    await expect(useCases.listMyOrganizations.execute({ userId: "user-1", limit: 0 })).rejects.toMatchObject({ kind: "validation" });
  });

  it("lists only the caller's own organizations, and nothing for a user without any", async () => {
    const { useCases } = await userInFourOrganizations();
    expect((await useCases.listMyOrganizations.execute({ userId: "owner-bravo" })).items.map((item) => item.slug)).toEqual(["bravo"]);
    expect(await useCases.listMyOrganizations.execute({ userId: "nobody" })).toEqual({ items: [], nextCursor: null, identityPending: false });
  });

  it("says that the identity provider may not hold every membership while the user's sync item is queued", async () => {
    const { useCases, identitySync, identity, tenants } = await userInFourOrganizations();
    expect((await useCases.listMyOrganizations.execute({ userId: "user-1" })).identityPending).toBe(true);

    for (let round = 0; round < 5; round += 1) await identitySync.runOnce();

    // One item reconciles all four memberships of the user.
    expect(tenants.every((tenant) => identity.members.has(`${tenant.id}:user-1`))).toBe(true);
    expect(identity.roleOf(tenants[0]?.id ?? "", "user-1")).toBe("tenant-admin");
    expect(identity.roleOf(tenants[3]?.id ?? "", "user-1")).toBe("trader");
    expect((await useCases.listMyOrganizations.execute({ userId: "user-1" })).identityPending).toBe(false);
  });
});

describe("GetMe with several memberships", () => {
  it("shows the membership of the token's organization", async () => {
    const { useCases, tenants } = await userInFourOrganizations();

    const me = await useCases.getMe.execute({ userId: "user-1", tokenTenantId: tenants[1]?.id ?? null, tokenRoles: ["trader"] });

    expect(me).toMatchObject({ tenantId: tenants[1]?.id, role: "trader", tokenTenantId: tenants[1]?.id, tokenNeedsRefresh: false });
  });

  it("asks for a refresh when the token's role differs from the membership of its organization", async () => {
    const { useCases, tenants } = await userInFourOrganizations();
    const me = await useCases.getMe.execute({ userId: "user-1", tokenTenantId: tenants[0]?.id ?? null, tokenRoles: ["trader"] });
    expect(me).toMatchObject({ tenantId: tenants[0]?.id, role: "tenant-admin", tokenNeedsRefresh: true });
  });

  it("shows no membership to a token without an organization when the user belongs to several", async () => {
    const { useCases } = await userInFourOrganizations();
    const me = await useCases.getMe.execute({ userId: "user-1", tokenTenantId: null, tokenRoles: [] });
    expect(me).toMatchObject({ tenantId: null, role: null, tokenTenantId: null, tokenNeedsRefresh: false });
  });

  it("shows no membership when the token names an organization the user does not belong to", async () => {
    const { useCases } = await userInFourOrganizations();
    const me = await useCases.getMe.execute({ userId: "owner-alpha", tokenTenantId: "00000000-0000-7000-8000-00000000ffff", tokenRoles: ["trader"] });
    expect(me).toMatchObject({ tenantId: null, role: null, tokenNeedsRefresh: true });
  });

  it("shows the only membership to a token without an organization, so that the client learns its token is stale", async () => {
    const { useCases, tenants } = await userInFourOrganizations();
    const me = await useCases.getMe.execute({ userId: "owner-bravo", tokenTenantId: null, tokenRoles: [] });
    expect(me).toMatchObject({ tenantId: tenants[1]?.id, role: "tenant-admin", tokenNeedsRefresh: true });
  });
});
