import { describe, expect, it } from "vitest";
import { hashInviteCode } from "../../src/domain/invite.js";
import { Conflict, ValidationFailed } from "../../src/usecases/errors.js";
import { CreateTenant } from "../../src/usecases/create-tenant.js";
import { caller, createCore, storeFailingAtCommit } from "../support/harness.js";

describe("CreateTenant", () => {
  it("stores the tenant, a one-time admin invite, the TenantCreated event and a sync item together, and calls no identity method", async () => {
    const { useCases, store, identity } = createCore();

    const result = await useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("admin-1") });

    expect(result.tenant).toMatchObject({ name: "Acme", slug: "acme", status: "active", createdBy: "admin-1" });
    expect(result.adminInvite).toMatchObject({ role: "tenant-admin", maxUses: 1 });
    expect(result.adminInvite.expiresAt.toISOString()).toBe("2026-11-08T10:00:00.000Z");

    const state = store.snapshot();
    expect(state.tenants).toHaveLength(1);
    expect(state.invites).toHaveLength(1);
    expect(state.invites[0]).toMatchObject({
      codeHash: hashInviteCode(result.adminInvite.code),
      tenantId: result.tenant.id,
      role: "tenant-admin",
      maxUses: 1,
      uses: 0,
    });
    expect(JSON.stringify(state)).not.toContain(result.adminInvite.code);
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({
      aggregateId: result.tenant.id,
      subject: `chance.tenants.TenantCreated.${result.tenant.id}`,
      type: "si.chance.tenants.TenantCreated.v1",
      publishedAt: null,
      attempts: 0,
    });
    expect(state.outbox[0]?.payload).toMatchObject({
      tenantid: result.tenant.id,
      correlationid: "corr-1",
      causationid: "req-1",
      data: { tenantId: result.tenant.id, name: "Acme", slug: "acme" },
    });
    expect(state.identitySync).toEqual([
      expect.objectContaining({
        key: `tenant/${result.tenant.id}`,
        kind: "tenant",
        target: result.tenant.id,
        version: 1,
        dueAt: new Date("2026-11-01T10:00:00.000Z"),
        attempts: 0,
        lastError: null,
      }),
    ]);
    // The provider is not touched by the request: the reconciler creates the organization later.
    expect(identity.calls).toEqual([]);
    expect(identity.organizations.size).toBe(0);
  });

  it("is not affected by an identity provider that is down", async () => {
    const { useCases, store, identity } = createCore();
    identity.available = false;

    const result = await useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller() });

    expect(result.tenant.slug).toBe("acme");
    expect(store.snapshot().identitySync).toHaveLength(1);
    expect(identity.calls).toEqual([]);
  });

  it("refuses a taken slug and writes nothing more", async () => {
    const { useCases, store } = createCore();
    await useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller() });
    const before = store.snapshot();

    await expect(useCases.createTenant.execute({ name: "Other", slug: "acme", caller: caller() })).rejects.toMatchObject({
      kind: "conflict",
      code: "slug_taken",
    });
    expect(store.snapshot()).toEqual(before);
  });

  it("leaves nothing behind when another request takes the slug between the check and the insert", async () => {
    const { useCases, store } = createCore();
    // The slug looks free when it is checked, then another request takes it before the transaction.
    const original = store.repositories.tenants.findBySlug.bind(store.repositories.tenants);
    let first = true;
    store.repositories.tenants.findBySlug = async (slug) => {
      if (first) {
        first = false;
        await useCases.createTenant.execute({ name: "Winner", slug, caller: caller() });
        return null;
      }
      return original(slug);
    };

    await expect(useCases.createTenant.execute({ name: "Loser", slug: "race", caller: caller() })).rejects.toBeInstanceOf(Conflict);

    const state = store.snapshot();
    expect(state.tenants.map((tenant) => tenant.name)).toEqual(["Winner"]);
    // Only the winner has an invite, an event and a sync item; nothing of the loser is queued for the provider.
    expect(state.invites).toHaveLength(1);
    expect(state.outbox).toHaveLength(1);
    expect(state.identitySync.map((row) => row.target)).toEqual([state.tenants[0]?.id]);
  });

  it("writes nothing at all when the transaction fails", async () => {
    const core = createCore();
    const create = new CreateTenant({ ...core.deps, store: storeFailingAtCommit(core.store) }, 168);

    await expect(create.execute({ name: "Acme", slug: "acme", caller: caller() })).rejects.toThrow("database is down");

    expect(core.store.snapshot()).toEqual({ tenants: [], memberships: [], invites: [], outbox: [], identitySync: [] });
    expect(core.identity.calls).toEqual([]);
  });

  it("rejects an invalid slug and name as validation errors", async () => {
    const { useCases, store } = createCore();
    await expect(useCases.createTenant.execute({ name: "Acme", slug: "-bad-", caller: caller() })).rejects.toBeInstanceOf(
      ValidationFailed,
    );
    await expect(useCases.createTenant.execute({ name: " ", slug: "acme", caller: caller() })).rejects.toMatchObject({
      fields: [expect.objectContaining({ field: "name" })],
    });
    expect(store.snapshot().identitySync).toEqual([]);
  });
});
