import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caller, createCore } from "../support/harness.js";

async function tenantWithMembers() {
  const core = createCore();
  const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: "Acme Ltd", slug: "acme", caller: caller("platform-1") });
  await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("admin-1") });
  const trader = await core.useCases.createInvite.execute({ tenantId: tenant.id, role: "trader", maxUses: 5, expiresInHours: 24, caller: caller("admin-1") });
  await core.useCases.acceptInvite.execute({ code: trader.code, caller: caller("user-1") });
  return { ...core, tenant };
}

describe("ReconcileIdentity", () => {
  it("creates the organization of a tenant item with the tenant's name", async () => {
    const { reconcile, identity, tenant } = await tenantWithMembers();

    await reconcile.execute({ kind: "tenant", target: tenant.id });

    expect(identity.calls).toEqual([`ensureOrganization:${tenant.id}`]);
    expect(identity.organizations.get(tenant.id)).toBe("Acme Ltd");
  });

  it("does nothing for a tenant item whose tenant does not exist", async () => {
    const { reconcile, identity } = await tenantWithMembers();

    await reconcile.execute({ kind: "tenant", target: "00000000-0000-7000-8000-00000000ffff" });

    expect(identity.calls).toEqual([]);
  });

  it("makes the user a member of the organization and gives the role of the row for a member item", async () => {
    const { reconcile, identity, tenant } = await tenantWithMembers();

    await reconcile.execute({ kind: "member", target: "user-1" });

    expect(identity.calls).toEqual([`ensureOrganization:${tenant.id}`, `addMember:${tenant.id}:user-1`, `setRole:${tenant.id}:user-1:trader`]);
    expect(identity.organizations.has(tenant.id)).toBe(true);
    expect(identity.members.has(`${tenant.id}:user-1`)).toBe(true);
    expect(identity.roleOf(tenant.id, "user-1")).toBe("trader");
  });

  it("does nothing for a member item whose membership does not exist", async () => {
    const { reconcile, identity } = await tenantWithMembers();

    await reconcile.execute({ kind: "member", target: "nobody" });

    expect(identity.calls).toEqual([]);
  });

  it("is idempotent: repeating an item leaves the provider in the same state", async () => {
    const { reconcile, identity, tenant } = await tenantWithMembers();

    await reconcile.execute({ kind: "member", target: "admin-1" });
    const state = () => JSON.stringify([[...identity.organizations], [...identity.members], [...identity.roles]]);
    const once = state();
    await reconcile.execute({ kind: "member", target: "admin-1" });
    await reconcile.execute({ kind: "tenant", target: tenant.id });
    await reconcile.execute({ kind: "member", target: "admin-1" });

    expect(state()).toBe(once);
    expect(identity.roleOf(tenant.id, "admin-1")).toBe("tenant-admin");
  });

  it("converges to the current role after a change, not to the role at the time the item was queued", async () => {
    const { reconcile, useCases, identity, tenant } = await tenantWithMembers();
    await reconcile.execute({ kind: "member", target: "user-1" });
    expect(identity.roleOf(tenant.id, "user-1")).toBe("trader");

    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1") });
    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "trader", caller: caller("admin-1") });
    await useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("admin-1") });
    await reconcile.execute({ kind: "member", target: "user-1" });

    expect(identity.roleOf(tenant.id, "user-1")).toBe("tenant-admin");
  });

  it("passes a failure of the identity provider on as it is", async () => {
    const { reconcile, identity } = await tenantWithMembers();
    identity.available = false;
    await expect(reconcile.execute({ kind: "member", target: "user-1" })).rejects.toMatchObject({ name: "IdentityProviderUnavailable" });

    identity.available = true;
    identity.rejectWith = 403;
    await expect(reconcile.execute({ kind: "member", target: "user-1" })).rejects.toMatchObject({ name: "IdentityProviderRejected", status: 403 });
  });
});

describe("the use cases of the requests", () => {
  // ADR-054: requests write the database only. The use cases do not even receive an identity provider; this test
  // fails if one of them starts to import or name it again.
  it.each(["create-tenant", "accept-invite", "change-member-role", "create-invite", "get-me", "list-members", "list-tenants"])(
    "%s does not use the identity provider",
    (file) => {
      const text = readFileSync(new URL(`../../src/usecases/${file}.ts`, import.meta.url), "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // "identitySync" and "identityPending" are fine: they name the queue, not the provider.
      expect(code).not.toMatch(/\bidentity\b|\bIdentityProvider/i);
    },
  );
});
