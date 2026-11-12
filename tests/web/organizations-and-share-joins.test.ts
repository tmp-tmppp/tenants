import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { responseErrors } from "../support/contracts.js";
import { shareToken } from "../support/fake-markets.js";
import { caller, createHarness } from "../support/harness.js";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const MARKET = "018f3c1e-7a00-7000-8000-0000000000bb";

let h: Harness;
let acme: string;
let globex: string;
beforeAll(async () => {
  h = await createHarness();
  const first = await h.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
  const second = await h.useCases.createTenant.execute({ name: "Globex", slug: "globex", caller: caller("platform-1") });
  acme = first.tenant.id;
  globex = second.tenant.id;
  await h.useCases.acceptInvite.execute({ code: first.adminInvite.code, caller: caller("owner-1") });
  await h.useCases.acceptInvite.execute({ code: second.adminInvite.code, caller: caller("owner-2") });
  h.markets.links.set(shareToken(1), { linkType: "everyone", tenantId: acme, marketId: MARKET });
  h.markets.links.set(shareToken(2), { linkType: "members", tenantId: acme, marketId: MARKET });
  h.markets.links.set(shareToken(3), { linkType: "profiles", tenantId: globex, marketId: MARKET, emails: ["listed@example.com"] });
});
afterAll(async () => {
  await h.app.close();
});

async function call(method: "GET" | "POST", url: string, options: { token?: Parameters<Harness["bearer"]>[0] | null; body?: unknown } = {}) {
  const headers = options.token === null ? {} : await h.bearer(options.token ?? {});
  const response = await h.app.inject({ method, url, headers, ...(options.body === undefined ? {} : { payload: options.body as object }) });
  return { status: response.statusCode, headers: response.headers, body: response.body ? (JSON.parse(response.body) as Record<string, any>) : null };
}

const expectContract = (path: string, method: string, response: { status: number; body: unknown }) =>
  expect(responseErrors(path, method, response.status, response.body)).toEqual([]);

describe("GET /v1/me/organizations", () => {
  it("answers 401 without a token", async () => {
    const response = await call("GET", "/v1/me/organizations", { token: null });
    expect(response.status).toBe(401);
    expect(response.headers["content-type"]).toContain("application/problem+json");
  });

  it("lists the organizations of the caller for a token without an organization, and for one with an organization", async () => {
    for (const organization of [null, [acme]]) {
      const response = await call("GET", "/v1/me/organizations", { token: { sub: "owner-1", organization } });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ items: [{ alias: acme, tenantId: acme, name: "Acme", slug: "acme", role: "tenant-admin" }], nextCursor: null });
      expectContract("/v1/me/organizations", "get", response);
    }
  });

  it("pages with a cursor and shows every organization of a user who belongs to two", async () => {
    await h.useCases.acceptInvite.execute({
      code: (await h.useCases.createInvite.execute({ tenantId: globex, role: "trader", maxUses: 1, expiresInHours: 1, caller: caller("owner-2") })).code,
      caller: caller("owner-1"),
    });

    const first = await call("GET", "/v1/me/organizations?limit=1", { token: { sub: "owner-1" } });
    expect(first.body?.["items"]).toHaveLength(1);
    expect(first.body?.["nextCursor"]).toEqual(expect.any(String));
    expectContract("/v1/me/organizations", "get", first);
    const second = await call("GET", `/v1/me/organizations?limit=1&cursor=${encodeURIComponent(first.body?.["nextCursor"])}`, { token: { sub: "owner-1" } });
    expect(second.body?.["items"]).toMatchObject([{ alias: globex, role: "trader" }]);
    expect(second.body?.["nextCursor"]).toBeNull();
    expectContract("/v1/me/organizations", "get", second);
  });

  it("answers 400 for a limit outside 1..100 and for a cursor that is not one", async () => {
    for (const query of ["limit=0", "limit=101", "cursor=not-a-cursor"]) {
      const response = await call("GET", `/v1/me/organizations?${query}`, { token: { sub: "owner-1" } });
      expect(response.status, query).toBe(400);
      expectContract("/v1/me/organizations", "get", response);
    }
  });

  it("returns an empty list for a user without a membership", async () => {
    const response = await call("GET", "/v1/me/organizations", { token: { sub: "nobody" } });
    expect(response.body).toEqual({ items: [], nextCursor: null, identityPending: false });
  });
});

describe("POST /v1/share-joins", () => {
  it("answers 401 without a token", async () => {
    const response = await call("POST", "/v1/share-joins", { token: null, body: { token: shareToken(1) } });
    expect(response.status).toBe(401);
  });

  it("joins the organization of the market with a token that has no organization, then answers the same again", async () => {
    const first = await call("POST", "/v1/share-joins", { token: { sub: "visitor-1" }, body: { token: shareToken(1) } });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ alias: acme, tenantId: acme, name: "Acme", marketId: MARKET, role: "trader", joined: true });
    expectContract("/v1/share-joins", "post", first);

    const again = await call("POST", "/v1/share-joins", { token: { sub: "visitor-1", organization: [globex] }, body: { token: shareToken(1) } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alias: acme, role: "trader", joined: false });
    expectContract("/v1/share-joins", "post", again);
    // The organization comes from the link, not from the token.
    expect((await call("GET", "/v1/me/organizations", { token: { sub: "visitor-1" } })).body?.["items"]).toMatchObject([{ alias: acme, role: "trader" }]);
  });

  it("gives markets the e-mail claims of the token: verified only when the claim is the boolean true", async () => {
    const before = h.markets.requests.length;
    await call("POST", "/v1/share-joins", { token: { sub: "v-a", claims: { email: "a@example.com", email_verified: true } }, body: { token: shareToken(1) } });
    await call("POST", "/v1/share-joins", { token: { sub: "v-b", claims: { email: "b@example.com", email_verified: "true" } }, body: { token: shareToken(1) } });
    await call("POST", "/v1/share-joins", { token: { sub: "v-c", claims: { email: "", email_verified: true } }, body: { token: shareToken(1) } });
    await call("POST", "/v1/share-joins", { token: { sub: "v-d" }, body: { token: shareToken(1) } });

    expect(h.markets.requests.slice(before).map(({ userEmail, emailVerified }) => ({ userEmail, emailVerified }))).toEqual([
      { userEmail: "a@example.com", emailVerified: true },
      { userEmail: "b@example.com", emailVerified: false },
      { userEmail: null, emailVerified: true },
      { userEmail: null, emailVerified: false },
    ]);
  });

  it("answers a link for chosen profiles by the verified e-mail address", async () => {
    const listed = await call("POST", "/v1/share-joins", {
      token: { sub: "listed-1", claims: { email: "Listed@Example.com", email_verified: true } },
      body: { token: shareToken(3) },
    });
    expect(listed.body).toMatchObject({ alias: globex, joined: true });
    const stranger = await call("POST", "/v1/share-joins", {
      token: { sub: "stranger-1", claims: { email: "stranger@example.com", email_verified: true } },
      body: { token: shareToken(3) },
    });
    expect(stranger.status).toBe(403);
    expect(stranger.body).toMatchObject({ code: "share_link_not_permitted" });
    expectContract("/v1/share-joins", "post", stranger);
  });

  it("answers 403 for a link for members only to a non-member, and lets a member in", async () => {
    const outsider = await call("POST", "/v1/share-joins", { token: { sub: "outsider-1" }, body: { token: shareToken(2) } });
    expect(outsider.status).toBe(403);
    expect(outsider.body).toMatchObject({ code: "share_link_members_only" });
    expectContract("/v1/share-joins", "post", outsider);

    const member = await call("POST", "/v1/share-joins", { token: { sub: "owner-1" }, body: { token: shareToken(2) } });
    expect(member.body).toMatchObject({ alias: acme, role: "tenant-admin", joined: false });
    expectContract("/v1/share-joins", "post", member);
  });

  it("answers 404 for an unknown link", async () => {
    const response = await call("POST", "/v1/share-joins", { token: { sub: "visitor-9" }, body: { token: shareToken(77) } });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "share_link_not_found" });
    expectContract("/v1/share-joins", "post", response);
  });

  it("answers 400 for a body that is not a token of 43 base64url characters", async () => {
    for (const body of [{}, { token: "short" }, { token: `${shareToken(1)}!` }, { token: shareToken(1), extra: 1 }, { token: 5 }]) {
      const response = await call("POST", "/v1/share-joins", { token: { sub: "visitor-9" }, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expectContract("/v1/share-joins", "post", response);
    }
  });

  it("answers 503 with Retry-After while markets cannot be asked", async () => {
    h.markets.failWith = "TimeoutError";
    try {
      const response = await call("POST", "/v1/share-joins", { token: { sub: "visitor-8" }, body: { token: shareToken(1) } });
      expect(response.status).toBe(503);
      expect(response.headers["retry-after"]).toBe("5");
      expect(response.body).toMatchObject({ code: "market_service_unavailable" });
      expectContract("/v1/share-joins", "post", response);
    } finally {
      h.markets.failWith = null;
    }
  });

  it("writes no share token to any log line, also not for a failed request", async () => {
    await call("POST", "/v1/share-joins", { token: { sub: "visitor-7" }, body: { token: shareToken(1) } });
    await call("POST", "/v1/share-joins", { token: { sub: "visitor-7" }, body: { token: shareToken(404) } });
    await call("POST", "/v1/share-joins", { token: { sub: "visitor-7" }, body: { token: "short" } });

    expect(h.logLines.length).toBeGreaterThan(0);
    const logs = h.logLines.join("");
    for (const n of [1, 2, 3, 404]) expect(logs).not.toContain(shareToken(n));
  });
});
