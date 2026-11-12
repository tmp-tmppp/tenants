import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { memberJoinedEvent, memberRoleChangedEvent, natsSubject, tenantCreatedEvent } from "../../src/domain/events.js";
import type { EventName } from "../../src/domain/events.js";
import { asyncapi, eventErrors, openapi } from "../support/contracts.js";
import { FakeMarkets, shareToken } from "../support/fake-markets.js";
import { caller, createCore, createHarness } from "../support/harness.js";

const METHODS = ["get", "post", "put", "patch", "delete"];

describe("contracts/markets-admission.openapi.yaml", () => {
  const admission = parse(readFileSync(new URL("../../contracts/markets-admission.openapi.yaml", import.meta.url), "utf8")) as Record<string, any>;
  const operation = admission["paths"]["/v1/internal/share-links/admission"]?.post;

  it("describes one internal operation with the answers markets gives, behind the service token", () => {
    expect(admission["openapi"]).toMatch(/^3\.1\./);
    expect(Object.keys(admission["paths"])).toEqual(["/v1/internal/share-links/admission"]);
    expect(Object.keys(operation.responses).sort()).toEqual(["200", "400", "401", "403", "404"]);
    expect(admission["components"].securitySchemes.serviceToken).toBeDefined();
  });

  it("keeps the fake of markets to the contract: it refuses a request and a link that the contract does not allow", async () => {
    const markets = new FakeMarkets();
    const tenantId = "018f3c1e-7a00-7000-8000-0000000000aa";
    const marketId = "018f3c1e-7a00-7000-8000-0000000000bb";
    markets.links.set(shareToken(1), { linkType: "profiles", tenantId, marketId, emails: ["a@example.com"] });
    markets.links.set(shareToken(2), { linkType: "everyone", tenantId: "not-a-uuid", marketId });

    await expect(markets.admit({ token: shareToken(1), userEmail: "a@example.com", emailVerified: true })).resolves.toEqual({
      kind: "answered",
      decision: "join",
      linkType: "profiles",
      tenantId,
      marketId,
    });
    await expect(markets.admit({ token: shareToken(1), userEmail: null, emailVerified: false })).resolves.toMatchObject({ decision: "denied" });
    expect(() => markets.admit({ token: "short", userEmail: null, emailVerified: false })).toThrow("does not match the admission contract");
    expect(() => markets.admit({ token: shareToken(1), userEmail: null, emailVerified: false, extra: 1 } as never)).toThrow("does not match");
    expect(() => markets.admit({ token: shareToken(2), userEmail: null, emailVerified: false })).toThrow("answer does not match");
  });
});

describe("contracts/openapi.yaml", () => {
  it("lists exactly the routes the application registers", async () => {
    const harness = await createHarness();
    const registered = harness.app.registeredRoutes
      .filter((route) => !["HEAD", "OPTIONS"].includes(route.method))
      .map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, "{$1}")}`)
      .sort();
    const documented = Object.entries(openapi["paths"] as Record<string, Record<string, unknown>>)
      .flatMap(([path, item]) => Object.keys(item).filter((key) => METHODS.includes(key)).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();
    await harness.app.close();

    expect(registered.length).toBeGreaterThanOrEqual(9);
    expect(registered).toEqual(documented);
  });

  it("is OpenAPI 3.1 with a bearer scheme, unique operation ids and resolvable references", () => {
    expect(openapi["openapi"]).toMatch(/^3\.1\./);
    expect(openapi["components"].securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(openapi["security"]).toEqual([{ bearerAuth: [] }]);

    const ids: string[] = [];
    for (const item of Object.values(openapi["paths"] as Record<string, Record<string, { operationId?: string }>>)) {
      for (const [method, operation] of Object.entries(item)) if (METHODS.includes(method)) ids.push(operation.operationId ?? "");
    }
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const ref of refs) {
      const target = ref.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], openapi);
      expect(target, `reference #/${ref}`).toBeDefined();
    }
  });

  it("leaves only the health probes without a security requirement", () => {
    const open: string[] = [];
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Record<string, { security?: unknown[] }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (METHODS.includes(method) && Array.isArray(operation.security) && operation.security.length === 0) open.push(path);
      }
    }
    expect(open.sort()).toEqual(["/health/live", "/health/ready", "/health/startup"]);
  });

  it("documents 503 with a Retry-After header on every authenticated operation, through one shared response", () => {
    const shared = openapi["components"].responses.ServiceUnavailable;
    expect(shared.headers["Retry-After"]).toMatchObject({ schema: { type: "integer" } });
    expect(Object.keys(shared.content)).toEqual(["application/problem+json"]);

    const authenticated: string[] = [];
    for (const [path, item] of Object.entries(openapi["paths"] as Record<string, Record<string, { security?: unknown[]; responses: Record<string, any> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method) || (Array.isArray(operation.security) && operation.security.length === 0)) continue;
        authenticated.push(`${method.toUpperCase()} ${path}`);
        expect(operation.responses["503"], `${method} ${path}`).toEqual({ $ref: "#/components/responses/ServiceUnavailable" });
      }
    }
    expect(authenticated).toHaveLength(9);
    expect(authenticated).toEqual(expect.arrayContaining(["GET /v1/me/organizations", "POST /v1/share-joins"]));
  });

  it("documents the problem+json answer of every error status", () => {
    for (const item of Object.values(openapi["paths"] as Record<string, Record<string, { responses: Record<string, any> }>>)) {
      for (const [method, operation] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) < 400) continue;
          const resolved = response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop() ?? ""] : response;
          expect(Object.keys(resolved.content), `${method} ${status}`).toEqual(["application/problem+json"]);
        }
      }
    }
  });
});

describe("contracts/asyncapi.yaml", () => {
  const ctx = { eventId: "018f3c1e-7a00-7000-8000-000000000001", now: new Date("2026-11-01T10:00:00.000Z"), correlationId: "corr-1", causationId: "req-1" };
  const tenantId = "018f3c1e-7a00-7000-8000-0000000000aa";

  it("is AsyncAPI 3.0 with one channel and one send operation per event", () => {
    expect(asyncapi["asyncapi"]).toMatch(/^3\.0\./);
    const names: EventName[] = ["TenantCreated", "MemberJoined", "MemberRoleChanged"];
    const addresses = Object.values(asyncapi["channels"] as Record<string, { address: string }>).map((channel) => channel.address).sort();
    expect(addresses).toEqual(names.map((name) => natsSubject(name, "{tenantId}")).sort());
    const operations = Object.values(asyncapi["operations"] as Record<string, { action: string }>);
    expect(operations).toHaveLength(3);
    expect(operations.every((operation) => operation.action === "send")).toBe(true);
  });

  it("accepts what the three event builders produce", () => {
    const created = tenantCreatedEvent({ id: tenantId, name: "Acme", slug: "acme", createdAt: ctx.now }, ctx);
    const joined = memberJoinedEvent({ tenantId, userId: "u-1", role: "trader", joinedAt: ctx.now }, ctx);
    const changed = memberRoleChangedEvent(
      { tenantId, userId: "u-1", oldRole: "trader", newRole: "tenant-admin", changedBy: "a-1", changedAt: ctx.now },
      ctx,
    );
    expect(eventErrors("TenantCreatedEvent", created)).toEqual([]);
    expect(eventErrors("MemberJoinedEvent", joined)).toEqual([]);
    expect(eventErrors("MemberRoleChangedEvent", changed)).toEqual([]);
  });

  it("accepts the optional via and marketId of MemberJoined, and refuses an unknown via", () => {
    const base = { tenantId, userId: "u-1", role: "trader" as const, joinedAt: ctx.now };
    const viaLink = memberJoinedEvent(base, ctx, { via: "share_link", marketId: "018f3c1e-7a00-7000-8000-0000000000bb" });
    const viaInvite = memberJoinedEvent(base, ctx, { via: "invite" });
    expect(eventErrors("MemberJoinedEvent", viaLink)).toEqual([]);
    expect(eventErrors("MemberJoinedEvent", viaInvite)).toEqual([]);
    expect(eventErrors("MemberJoinedEvent", { ...viaLink, data: { ...(viaLink as any).data, via: "carrier-pigeon" } })).not.toEqual([]);
  });

  it("accepts the events the use cases really write to the outbox", async () => {
    const core = createCore();
    const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
    await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("founder") });
    const trader = await core.useCases.createInvite.execute({ tenantId: tenant.id, role: "trader", maxUses: 1, expiresInHours: 1, caller: caller("founder") });
    await core.useCases.acceptInvite.execute({ code: trader.code, caller: caller("user-1") });
    await core.useCases.changeMemberRole.execute({ tenantId: tenant.id, userId: "user-1", role: "tenant-admin", caller: caller("founder") });

    const bySchema: Record<string, string> = {
      "si.chance.tenants.TenantCreated.v1": "TenantCreatedEvent",
      "si.chance.tenants.MemberJoined.v1": "MemberJoinedEvent",
      "si.chance.tenants.MemberRoleChanged.v1": "MemberRoleChangedEvent",
    };
    const rows = core.store.snapshot().outbox;
    expect(new Set(rows.map((row) => row.type))).toEqual(new Set(Object.keys(bySchema)));
    for (const row of rows) {
      expect(eventErrors(bySchema[row.type] ?? "", row.payload), row.type).toEqual([]);
      expect(row.id).toBe(row.payload.id);
    }
  });

  it("rejects an event that breaks the contract", () => {
    const good = tenantCreatedEvent({ id: tenantId, name: "Acme", slug: "acme", createdAt: ctx.now }, ctx);
    const { tenantid: _removed, ...withoutTenant } = good;
    expect(eventErrors("TenantCreatedEvent", withoutTenant)).not.toEqual([]);
    expect(eventErrors("TenantCreatedEvent", { ...good, specversion: "0.3" })).not.toEqual([]);
    expect(eventErrors("TenantCreatedEvent", { ...good, type: "si.chance.tenants.MemberJoined.v1" })).not.toEqual([]);
    // A field the contract does not know, such as an e-mail address, must not slip into the data.
    expect(eventErrors("TenantCreatedEvent", { ...good, data: { ...good.data, email: "someone@example.test" } })).not.toEqual([]);
    expect(eventErrors("TenantCreatedEvent", { ...good, id: "not-a-uuid" })).not.toEqual([]);
  });
});
