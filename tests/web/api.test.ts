import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { responseErrors } from "../support/contracts.js";
import { createHarness } from "../support/harness.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.app.close();
});

const PLATFORM = { sub: "platform-1", roles: ["platform-admin"] };

async function call(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT",
  url: string,
  options: { token?: Parameters<Harness["bearer"]>[0] | null; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers = { ...(options.token === null ? {} : await h.bearer(options.token ?? {})), ...options.headers };
  const response = await app.inject({ method, url, headers, ...(options.body === undefined ? {} : { payload: options.body as object }) });
  const text = response.body;
  return { status: response.statusCode, headers: response.headers, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

/** Asserts that a real response has the shape written in contracts/openapi.yaml. */
function expectContract(path: string, method: string, response: { status: number; body: unknown }) {
  expect(responseErrors(path, method, response.status, response.body)).toEqual([]);
}

describe("authentication and authorization", () => {
  it("answers 401 without a token, with a malformed header and with a bad token", async () => {
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer not.a.jwt" }]) {
      const response = await h.app.inject({ method: "GET", url: "/v1/me", headers });
      expect(response.statusCode).toBe(401);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["www-authenticate"]).toContain("Bearer");
    }
  });

  it("answers 401 for a token with the wrong issuer, audience, signature or an expired one", async () => {
    const bad = [
      await h.keys.sign({ issuer: "http://localhost:8081/realms/other" }),
      await h.keys.sign({ audience: "someone-else" }),
      await h.keys.signWithOtherKey({}),
      await h.keys.sign({ expiresIn: -60 }),
    ];
    for (const token of bad) {
      const response = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).toBe(401);
    }
  });

  it("answers 401 for an unsigned token", async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"x"}').toString("base64url")}.`;
    const response = await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${unsigned}` } });
    expect(response.statusCode).toBe(401);
  });

  it("answers 403 to a caller without the required role", async () => {
    const asTrader = await call(h.app, "GET", "/v1/tenants", { token: { roles: ["trader"] } });
    expect(asTrader.status).toBe(403);
    expect(asTrader.body).toMatchObject({ status: 403, code: "forbidden" });
    const create = await call(h.app, "POST", "/v1/tenants", { token: { roles: ["tenant-admin"] }, body: { name: "Acme", slug: "acme-x" } });
    expect(create.status).toBe(403);
  });

  it("checks the role before it validates the body", async () => {
    const response = await call(h.app, "POST", "/v1/tenants", { token: { roles: ["trader"] }, body: { nonsense: true } });
    expect(response.status).toBe(403);
  });

  it("rejects a token that names more than one organization, and accepts both claim shapes", async () => {
    expect((await call(h.app, "GET", "/v1/me", { token: { organization: ["a", "b"] } })).status).toBe(401);
    expect((await call(h.app, "GET", "/v1/me", { token: { organization: { a: { id: "1" }, b: { id: "2" } } } })).status).toBe(401);
    const asObject = await call(h.app, "GET", "/v1/me", { token: { organization: { "tenant-one": { id: "1" } } } });
    expect(asObject.body).toMatchObject({ tokenTenantId: "tenant-one" });
    const asArray = await call(h.app, "GET", "/v1/me", { token: { organization: ["tenant-two"] } });
    expect(asArray.body).toMatchObject({ tokenTenantId: "tenant-two" });
    const asString = await call(h.app, "GET", "/v1/me", { token: { organization: "tenant-three" } });
    expect(asString.body).toMatchObject({ tokenTenantId: "tenant-three" });
  });

  it("does not write the token into the logs", async () => {
    const token = await h.keys.sign({ sub: "log-check" });
    await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    await h.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer broken.token.value" } });
    const logs = h.logLines.join("");
    expect(logs).toContain("log-check");
    expect(logs).not.toContain(token);
    expect(logs).not.toContain("broken.token.value");
  });
});

describe("platform admin endpoints", () => {
  it("creates a tenant, returns the admin invite once and lists the tenant", async () => {
    const created = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Acme Ltd", slug: "acme" } });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      tenant: { name: "Acme Ltd", slug: "acme", status: "active", createdBy: "platform-1" },
      adminInvite: { role: "tenant-admin", maxUses: 1, code: expect.any(String), expiresAt: expect.any(String) },
    });
    expectContract("/v1/tenants", "post", created);

    const list = await call(h.app, "GET", "/v1/tenants?limit=10", { token: PLATFORM });
    expect(list.status).toBe(200);
    expect(list.body?.["items"]).toEqual([expect.objectContaining({ slug: "acme" })]);
    expect(list.body?.["nextCursor"]).toBeNull();
    expectContract("/v1/tenants", "get", list);
    expect(JSON.stringify(list.body)).not.toContain(created.body?.["adminInvite"].code);
  });

  it("answers 409 for a taken slug as problem+json", async () => {
    const again = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Other", slug: "acme" } });
    expect(again.status).toBe(409);
    expect(again.headers["content-type"]).toContain("application/problem+json");
    expect(again.body).toEqual({
      type: "urn:chance:problem:slug-taken",
      title: "Conflict",
      status: 409,
      detail: 'The slug "acme" is already taken',
      instance: "/v1/tenants",
      code: "slug_taken",
    });
    expectContract("/v1/tenants", "post", again);
  });

  it("answers 400 and names every invalid field", async () => {
    const response = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "", slug: "Bad Slug", extra: 1 } });
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const fields = (response.body?.["errors"] as Array<{ field: string }>).map((e) => e.field).sort();
    expect(fields).toEqual(["extra", "name", "slug"]);
    expectContract("/v1/tenants", "post", response);

    const missing = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: {} });
    expect((missing.body?.["errors"] as Array<{ field: string }>).map((e) => e.field).sort()).toEqual(["name", "slug"]);

    const query = await call(h.app, "GET", "/v1/tenants?limit=500", { token: PLATFORM });
    expect(query.status).toBe(400);
    expect(query.body?.["errors"]).toEqual([expect.objectContaining({ field: "limit" })]);

    const cursor = await call(h.app, "GET", "/v1/tenants?cursor=garbage", { token: PLATFORM });
    expect(cursor.status).toBe(400);
    expect(cursor.body?.["errors"]).toEqual([expect.objectContaining({ field: "cursor" })]);
  });

  it("answers 400 for a tenant name with a control character and stores nothing", async () => {
    const before = h.store.snapshot().tenants.length;
    for (const name of ["Acme\u0000Ltd", "Acme\u0000", "Acme\nLtd", "Acme\u0007Ltd", "   "]) {
      const response = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name, slug: "control-chars" } });
      expect(response.status, JSON.stringify(name)).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body?.["errors"]).toEqual([expect.objectContaining({ field: "name" })]);
      expectContract("/v1/tenants", "post", response);
    }
    expect(h.store.snapshot().tenants).toHaveLength(before);

    const padded = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "  \t Padded Ltd \n ", slug: "padded-ltd" } });
    expect(padded.status).toBe(201);
    expect(padded.body?.["tenant"].name).toBe("Padded Ltd");
  });

  it("answers 400 for a tenant name with a lone surrogate and stores nothing", async () => {
    const before = h.store.snapshot().tenants.length;
    for (const name of ["Acme\ud800", "\udc00Acme", "Ac\ud83cme"]) {
      const response = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name, slug: "lone-surrogate" } });
      expect(response.status, JSON.stringify(name)).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body?.["errors"]).toEqual([expect.objectContaining({ field: "name" })]);
      expectContract("/v1/tenants", "post", response);
    }
    expect(h.store.snapshot().tenants).toHaveLength(before);

    const emoji = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Choc \ud83c\udf6b", slug: "choc-pair" } });
    expect(emoji.status).toBe(201);
    expect(emoji.body?.["tenant"].name).toBe("Choc 🍫");
  });

  it("answers 400 for malformed JSON and 404 for an unknown route, both as problem+json", async () => {
    const bad = await h.app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { ...(await h.bearer(PLATFORM)), "content-type": "application/json" },
      payload: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers["content-type"]).toContain("application/problem+json");

    const missing = await h.app.inject({ method: "GET", url: "/v1/nothing-here" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/problem+json");
  });

  it("does not depend on the identity provider: it answers 201 while the provider is down and queues the work", async () => {
    h.identity.available = false;
    const response = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Down", slug: "down-co" } });
    h.identity.available = true;

    expect(response.status).toBe(201);
    expectContract("/v1/tenants", "post", response);
    expect(h.identity.calls).toEqual([]);
    const tenantId = response.body?.["tenant"].id;
    expect(h.store.snapshot().identitySync).toContainEqual(expect.objectContaining({ key: `tenant/${tenantId}` }));
    await h.identitySync.runOnce();
    expect(h.identity.organizations.get(tenantId)).toBe("Down");
  });
});

describe("a tenant's own endpoints", () => {
  let tenantId = "";
  let adminCode = "";

  beforeAll(async () => {
    const created = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Globex", slug: "globex" } });
    tenantId = created.body?.["tenant"].id;
    adminCode = created.body?.["adminInvite"].code;
  });

  it("lets a new user join with the admin invite and shows the stale token in /v1/me", async () => {
    const joined = await call(h.app, "POST", `/v1/invites/${adminCode}/accept`, { token: { sub: "founder" } });
    expect(joined.status).toBe(200);
    expect(joined.body).toEqual({ tenantId, role: "tenant-admin" });
    expectContract("/v1/invites/{code}/accept", "post", joined);

    // Keycloak follows a moment later: until the worker has been through, refreshing the token cannot help yet.
    const me = await call(h.app, "GET", "/v1/me", { token: { sub: "founder" } });
    expect(me.body).toEqual({ userId: "founder", tenantId, role: "tenant-admin", tokenTenantId: null, tokenNeedsRefresh: true, identityPending: true });
    expectContract("/v1/me", "get", me);

    await h.identitySync.runOnce();

    const synced = await call(h.app, "GET", "/v1/me", { token: { sub: "founder" } });
    expect(synced.body).toEqual({ userId: "founder", tenantId, role: "tenant-admin", tokenTenantId: null, tokenNeedsRefresh: true, identityPending: false });
    expectContract("/v1/me", "get", synced);
    expect(h.identity.roleOf(tenantId, "founder")).toBe("tenant-admin");

    const refreshed = await call(h.app, "GET", "/v1/me", { token: { sub: "founder", roles: ["tenant-admin"], organization: [tenantId] } });
    expect(refreshed.body).toMatchObject({ tokenNeedsRefresh: false, tokenTenantId: tenantId, identityPending: false });
  });

  const admin = () => ({ sub: "founder", roles: ["tenant-admin"], organization: [tenantId] });

  it("creates an invite with defaults, and one with explicit values", async () => {
    const withDefaults = await call(h.app, "POST", `/v1/tenants/${tenantId}/invites`, { token: admin() });
    expect(withDefaults.status).toBe(201);
    expect(withDefaults.body).toMatchObject({ role: "trader", maxUses: 1 });
    expectContract("/v1/tenants/{id}/invites", "post", withDefaults);
    const expires = new Date(withDefaults.body?.["expiresAt"]).getTime() - h.clock.now().getTime();
    expect(expires).toBe(168 * 3_600_000);

    const explicit = await call(h.app, "POST", `/v1/tenants/${tenantId}/invites`, {
      token: admin(),
      body: { role: "tenant-admin", maxUses: 3, expiresInHours: 2 },
    });
    expect(explicit.body).toMatchObject({ role: "tenant-admin", maxUses: 3 });

    const invalid = await call(h.app, "POST", `/v1/tenants/${tenantId}/invites`, { token: admin(), body: { maxUses: 101, role: "owner" } });
    expect(invalid.status).toBe(400);
    expect((invalid.body?.["errors"] as Array<{ field: string }>).map((e) => e.field).sort()).toEqual(["maxUses", "role"]);
  });

  it("lists members, changes a role and returns the membership", async () => {
    const invite = await call(h.app, "POST", `/v1/tenants/${tenantId}/invites`, { token: admin(), body: { maxUses: 2 } });
    await call(h.app, "POST", `/v1/invites/${invite.body?.["code"]}/accept`, { token: { sub: "trader-1" } });

    const members = await call(h.app, "GET", `/v1/tenants/${tenantId}/members`, { token: admin() });
    expect(members.status).toBe(200);
    expect(members.body?.["items"]).toEqual([
      expect.objectContaining({ userId: "founder", role: "tenant-admin" }),
      expect.objectContaining({ userId: "trader-1", role: "trader" }),
    ]);
    expect(Object.keys(members.body?.["items"][0]).sort()).toEqual(["joinedAt", "role", "userId"]);
    expectContract("/v1/tenants/{id}/members", "get", members);

    const changed = await call(h.app, "PUT", `/v1/tenants/${tenantId}/members/trader-1/role`, { token: admin(), body: { role: "tenant-admin" } });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ tenantId, userId: "trader-1", role: "tenant-admin" });
    expectContract("/v1/tenants/{id}/members/{userId}/role", "put", changed);

    const events = h.store.snapshot().outbox.filter((row) => row.type.endsWith("MemberRoleChanged.v1"));
    expect(events).toHaveLength(1);
    const again = await call(h.app, "PUT", `/v1/tenants/${tenantId}/members/trader-1/role`, { token: admin(), body: { role: "tenant-admin" } });
    expect(again.status).toBe(200);
    expect(h.store.snapshot().outbox.filter((row) => row.type.endsWith("MemberRoleChanged.v1"))).toHaveLength(1);
  });

  it("answers 404 for an unknown member and 409 for the last admin", async () => {
    const unknown = await call(h.app, "PUT", `/v1/tenants/${tenantId}/members/nobody/role`, { token: admin(), body: { role: "trader" } });
    expect(unknown.status).toBe(404);
    expectContract("/v1/tenants/{id}/members/{userId}/role", "put", unknown);

    // "founder" and "trader-1" are both admins now; demote one, then the other is the last.
    await call(h.app, "PUT", `/v1/tenants/${tenantId}/members/trader-1/role`, { token: admin(), body: { role: "trader" } });
    const last = await call(h.app, "PUT", `/v1/tenants/${tenantId}/members/founder/role`, { token: admin(), body: { role: "trader" } });
    expect(last.status).toBe(409);
    expect(last.body).toMatchObject({ code: "last_admin" });
    expectContract("/v1/tenants/{id}/members/{userId}/role", "put", last);
  });

  it("answers 400, never a database error, for a user id in the path with a control character or more than 255 characters", async () => {
    const change = (userId: string) =>
      call(h.app, "PUT", `/v1/tenants/${tenantId}/members/${userId}/role`, { token: admin(), body: { role: "trader" } });
    const events = () => h.store.snapshot().outbox.length;
    const before = events();

    for (const userId of ["a%00b", "%00", "a%0Ab", "a%09b", "a%1Bb", "a%7Fb", "a%C2%85b", "x".repeat(256)]) {
      const response = await change(userId);
      expect(response.status, userId).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body?.["errors"]).toEqual([expect.objectContaining({ field: "userId" })]);
      expectContract("/v1/tenants/{id}/members/{userId}/role", "put", response);
    }
    expect(events()).toBe(before);

    // Ordinary ids pass the check and are then unknown members (404), also at the longest accepted length.
    for (const userId of ["x", "marija.novak%40example.com", encodeURIComponent("č".repeat(255)), "x".repeat(255)]) {
      expect((await change(userId)).status, userId).toBe(404);
    }
  });

  it("answers a path parameter that is far too long, and a malformed URL, as problem details too", async () => {
    // 3061 characters is more than any user id of 255 code points can need when it is percent-encoded.
    const tooLong = await call(h.app, "PUT", `/v1/tenants/${tenantId}/members/${"x".repeat(3061)}/role`, { token: admin(), body: { role: "trader" } });
    expect(tooLong.status).toBe(414);
    expect(tooLong.headers["content-type"]).toContain("application/problem+json");
    expect(tooLong.body).toMatchObject({ status: 414, code: "uri_too_long", title: "URI Too Long", detail: "A path parameter is too long" });

    const malformed = await call(h.app, "GET", "/v1/tenants/%zz", { token: PLATFORM });
    expect(malformed.status).toBe(400);
    expect(malformed.headers["content-type"]).toContain("application/problem+json");
    expect(malformed.body).toMatchObject({ status: 400, code: "bad_request" });
  });

  it("answers 404, never 403, for the id of another tenant", async () => {
    const other = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Initech", slug: "initech" } });
    const otherId = other.body?.["tenant"].id;

    for (const [method, url, body] of [
      ["POST", `/v1/tenants/${otherId}/invites`, undefined],
      ["GET", `/v1/tenants/${otherId}/members`, undefined],
      ["PUT", `/v1/tenants/${otherId}/members/x/role`, { role: "trader" }],
    ] as const) {
      const response = await call(h.app, method, url, { token: admin(), body });
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: "not_found", title: "Not Found" });
    }
    // A platform admin without a tenant has no tenant-scoped rights either.
    expect((await call(h.app, "GET", `/v1/tenants/${tenantId}/members`, { token: PLATFORM })).status).toBe(404);
    // The same id as the token's tenant, without the tenant-admin role: 403.
    const trader = await call(h.app, "GET", `/v1/tenants/${tenantId}/members`, { token: { sub: "t", roles: ["trader"], organization: [tenantId] } });
    expect(trader.status).toBe(403);
    // No token at all: 401 comes first.
    expect((await h.app.inject({ method: "GET", url: `/v1/tenants/${otherId}/members` })).statusCode).toBe(401);
  });

  it("answers the accept endpoint's errors: 404, 410 and 409", async () => {
    expect((await call(h.app, "POST", "/v1/invites/this-code-does-not-exist/accept", { token: { sub: "u" } })).status).toBe(404);
    expect((await call(h.app, "POST", "/v1/invites/short/accept", { token: { sub: "u" } })).status).toBe(400);

    const single = await call(h.app, "POST", `/v1/tenants/${tenantId}/invites`, { token: admin() });
    await call(h.app, "POST", `/v1/invites/${single.body?.["code"]}/accept`, { token: { sub: "one" } });
    const usedUp = await call(h.app, "POST", `/v1/invites/${single.body?.["code"]}/accept`, { token: { sub: "two" } });
    expect(usedUp.status).toBe(410);
    expect(usedUp.body).toMatchObject({ code: "invite_used_up" });
    expectContract("/v1/invites/{code}/accept", "post", usedUp);

    const other = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Umbrella", slug: "umbrella" } });
    // A member of one tenant joins a second one: both memberships stay (one per user and tenant), no 409.
    const second = await call(h.app, "POST", `/v1/invites/${other.body?.["adminInvite"].code}/accept`, { token: { sub: "one" } });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ tenantId: other.body?.["tenant"].id, role: "tenant-admin" });
    expectContract("/v1/invites/{code}/accept", "post", second);
    const again = await call(h.app, "POST", `/v1/invites/${other.body?.["adminInvite"].code}/accept`, { token: { sub: "one" } });
    expect(again.body).toEqual(second.body);
    const mine = await call(h.app, "GET", "/v1/me/organizations", { token: { sub: "one" } });
    expect(mine.body?.["items"]).toHaveLength(2);
  });

  it("pages through tenants with the cursor of the response", async () => {
    const first = await call(h.app, "GET", "/v1/tenants?limit=1", { token: PLATFORM });
    expect(first.body?.["items"]).toHaveLength(1);
    expect(first.body?.["nextCursor"]).toEqual(expect.any(String));
    const second = await call(h.app, "GET", `/v1/tenants?limit=1&cursor=${first.body?.["nextCursor"]}`, { token: PLATFORM });
    expect(second.body?.["items"][0].id).not.toBe(first.body?.["items"][0].id);
  });
});

describe("crafted cursors", () => {
  const craft = (content: unknown): string => Buffer.from(JSON.stringify(content), "utf8").toString("base64url");
  const AT = "2026-11-01T10:00:00.000Z";
  const UUID = "00000000-0000-7000-8000-000000000042";
  let tenantId = "";

  beforeAll(async () => {
    const created = await call(h.app, "POST", "/v1/tenants", { token: PLATFORM, body: { name: "Cursors", slug: "cursors-co" } });
    tenantId = created.body?.["tenant"].id;
  });

  const tenantAdmin = () => ({ sub: "cursor-admin", roles: ["tenant-admin"], organization: [tenantId] });
  const tenantList = (cursor: string) => call(h.app, "GET", `/v1/tenants?cursor=${encodeURIComponent(cursor)}`, { token: PLATFORM });
  const memberList = (cursor: string) => call(h.app, "GET", `/v1/tenants/${tenantId}/members?cursor=${encodeURIComponent(cursor)}`, { token: tenantAdmin() });

  const badForTenants = [
    ["a year beyond 9999", craft({ a: "+275760-09-13T00:00:00.000Z", k: UUID })],
    ["a time before 1970", craft({ a: "1969-12-31T23:59:59.999Z", k: UUID })],
    ["a time that is no date", craft({ a: "2026-02-30T00:00:00.000Z", k: UUID })],
    ["a key that is no UUID", craft({ a: AT, k: "not-a-uuid" })],
    ["a user id as key", craft({ a: AT, k: "some-user" })],
    ["an empty key", craft({ a: AT, k: "" })],
    ["a key with NUL", craft({ a: AT, k: `${UUID}\u0000` })],
    ["not base64url JSON", "bm90IGpzb24"],
  ] as const;

  it.each(badForTenants)("answers 400 on the tenant list for %s", async (_label, cursor) => {
    const response = await tenantList(cursor);
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ code: "validation_failed", errors: [{ field: "cursor" }] });
    expectContract("/v1/tenants", "get", response);
  });

  const badForMembers = [
    ["a year beyond 9999", craft({ a: "+275760-09-13T00:00:00.000Z", k: "user-1" })],
    ["a time before 1970", craft({ a: "1969-12-31T23:59:59.999Z", k: "user-1" })],
    ["an empty key", craft({ a: AT, k: "" })],
    ["a key of 256 characters", craft({ a: AT, k: "x".repeat(256) })],
    ["a key with NUL", craft({ a: AT, k: "user\u00001" })],
    ["a key with a line break", craft({ a: AT, k: "user\n1" })],
    ["a key that is no string", craft({ a: AT, k: 1 })],
  ] as const;

  it.each(badForMembers)("answers 400 on the member list for %s", async (_label, cursor) => {
    const response = await memberList(cursor);
    expect(response.status).toBe(400);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.body).toMatchObject({ code: "validation_failed", errors: [{ field: "cursor" }] });
    expectContract("/v1/tenants/{id}/members", "get", response);
  });

  it("still accepts the cursors the service issues and a hand-made one of the right shape", async () => {
    const first = await call(h.app, "GET", "/v1/tenants?limit=1", { token: PLATFORM });
    const next = await tenantList(first.body?.["nextCursor"]);
    expect(next.status).toBe(200);
    expect((await tenantList(craft({ a: AT, k: UUID }))).status).toBe(200);
    expect((await memberList(craft({ a: AT, k: "a.user@example.com" }))).status).toBe(200);
    expect((await memberList(craft({ a: AT, k: UUID }))).status).toBe(200);
  });
});

describe("correlation", () => {
  it("returns the correlation id the caller sent and puts it into the events", async () => {
    const created = await call(h.app, "POST", "/v1/tenants", {
      token: PLATFORM,
      body: { name: "Correlated", slug: "correlated" },
      headers: { "x-correlation-id": "trace-abc.123" },
    });
    expect(created.headers["x-correlation-id"]).toBe("trace-abc.123");

    const event = h.store.snapshot().outbox.find((row) => row.aggregateId === created.body?.["tenant"].id);
    expect(event?.payload).toMatchObject({ correlationid: "trace-abc.123", tenantid: created.body?.["tenant"].id });
    expect(event?.payload.causationid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("generates a UUID when none is sent or when the value is not acceptable", async () => {
    const none = await call(h.app, "GET", "/v1/me", { token: {} });
    expect(none.headers["x-correlation-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const odd = await call(h.app, "GET", "/v1/me", { token: {}, headers: { "x-correlation-id": "bad value with spaces\u0000" } });
    expect(odd.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("binds the correlation id, the user and the tenant to the request log", async () => {
    await call(h.app, "GET", "/v1/me", { token: { sub: "log-user", organization: ["log-tenant"] }, headers: { "x-correlation-id": "log-corr-1" } });
    const lines = h.logLines.join("").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line["correlationId"] === "log-corr-1" && line["userId"] === "log-user" && line["tenantId"] === "log-tenant")).toBe(true);
  });
});

describe("health", () => {
  it("answers the three probes without a token", async () => {
    for (const probe of ["startup", "ready", "live"]) {
      const response = await h.app.inject({ method: "GET", url: `/health/${probe}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "up" });
    }
  });

  it("is not ready when the database does not answer, and still alive", async () => {
    const original = h.store.ping.bind(h.store);
    h.store.ping = () => Promise.reject(new Error("db down"));
    const ready = await h.app.inject({ method: "GET", url: "/health/ready" });
    const live = await h.app.inject({ method: "GET", url: "/health/live" });
    h.store.ping = original;

    expect(ready.statusCode).toBe(503);
    expect(ready.headers["content-type"]).toContain("application/problem+json");
    expect(live.statusCode).toBe(200);
  });

  it("turns not ready as soon as the process drains (SIGTERM), while the other probes and the API keep answering", async () => {
    expect((await h.app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);

    h.setDraining(true);
    try {
      const ready = await h.app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.headers["content-type"]).toContain("application/problem+json");
      expect(ready.json()).toMatchObject({ status: 503, code: "shutting_down", instance: "/health/ready" });
      expectContract("/health/ready", "get", { status: 503, body: ready.json() });

      // The service still works during the delay: liveness, startup and requests in flight or arriving late.
      expect((await h.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
      expect((await h.app.inject({ method: "GET", url: "/health/startup" })).statusCode).toBe(200);
      expect((await call(h.app, "GET", "/v1/me", { token: {} })).status).toBe(200);
    } finally {
      h.setDraining(false);
    }
    expect((await h.app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
  });

  it("does not ask the database while draining", async () => {
    const original = h.store.ping.bind(h.store);
    let pings = 0;
    h.store.ping = () => {
      pings += 1;
      return original();
    };
    h.setDraining(true);
    try {
      await h.app.inject({ method: "GET", url: "/health/ready" });
    } finally {
      h.setDraining(false);
      h.store.ping = original;
    }
    expect(pings).toBe(0);
  });
});
