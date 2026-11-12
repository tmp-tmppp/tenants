import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeycloakIdentityProvider } from "../../src/adapters/keycloak/keycloak-identity-provider.js";
import type { KeycloakOptions } from "../../src/adapters/keycloak/keycloak-identity-provider.js";
import { IdentityProviderRejected, IdentityProviderUnavailable } from "../../src/usecases/errors.js";
import { ReconcileIdentity } from "../../src/usecases/reconcile-identity.js";
import { caller, createCore } from "../support/harness.js";

const TENANT = "00000000-0000-7000-8000-000000000001";
const ORG_ID = "kc-org-1";
const USER = "user-1";
/** The id the fake gives to the top-level group of an organization. */
const groupId = (orgId: string, name: string): string => `group-${orgId}-${name}`;

/** What one organization holds in the fake: its members, its top-level groups (name -> id) and who is in which group. */
interface OrgState {
  members: Set<string>;
  groups: Map<string, string>;
  groupMembers: Map<string, Set<string>>;
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  authorization: string | undefined;
}

/** A small stand-in for Keycloak's token endpoint and the admin calls this service uses. */
class FakeKeycloak {
  readonly requests: Recorded[] = [];
  readonly organizations = new Map<string, { id: string; alias: string; name: string }>();
  /** The state of every organization, by organization id. */
  readonly states = new Map<string, OrgState>();
  /** The next join of a group is lost to another run: the user is put in the group and the answer is 409. */
  raceOnGroupJoin = false;
  /** Every join of a group answers this status (a refusal that is not "already a member"). */
  refuseGroupJoinWith: number | null = null;
  /** The members, role groups and group members of the first organization, which most tests use. */
  get members(): Set<string> {
    return this.stateOf(ORG_ID).members;
  }
  get groups(): Map<string, string> {
    return this.stateOf(ORG_ID).groups;
  }
  get groupMembers(): Map<string, Set<string>> {
    return this.stateOf(ORG_ID).groupMembers;
  }

  stateOf(orgId: string): OrgState {
    let state = this.states.get(orgId);
    if (!state) {
      state = { members: new Set(), groups: new Map(), groupMembers: new Map() };
      this.states.set(orgId, state);
    }
    return state;
  }
  /** The next admin calls answer with these statuses (without doing anything). */
  failWith: number[] = [];
  /** 401 once for admin calls, as if the cached token had been revoked. */
  rejectTokenOnce = false;
  hang = false;
  tokenLifetime = 300;
  /** Status of the token endpoint; anything but 200 is an error answer. */
  tokenStatus = 200;
  private server: Server = createServer((req, res) => void this.handle(req, res));
  url = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  count(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://fake");
    const record: Recorded = {
      method: req.method ?? "",
      path: url.pathname,
      query: url.searchParams,
      body: Buffer.concat(chunks).toString("utf8"),
      authorization: req.headers.authorization,
    };
    this.requests.push(record);
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (this.hang) return;
    if (record.path.endsWith("/protocol/openid-connect/token")) {
      if (this.tokenStatus !== 200) return send(this.tokenStatus, { error: "invalid_client" });
      return send(200, { access_token: `token-${this.count("POST", /openid-connect\/token$/)}`, expires_in: this.tokenLifetime });
    }
    if (this.rejectTokenOnce) {
      this.rejectTokenOnce = false;
      return send(401, { error: "invalid_token" });
    }
    const failure = this.failWith.shift();
    if (failure !== undefined) return send(failure, { error: "injected" });

    const base = "/admin/realms/chance";
    const path = record.path;
    if (record.method === "GET" && path === `${base}/organizations`) {
      const search = record.query.get("search") ?? "";
      // Like Keycloak: an exact search matches the name (and domains), not the alias.
      return send(200, [...this.organizations.values()].filter((org) => org.name === search));
    }
    if (record.method === "POST" && path === `${base}/organizations`) {
      const body = JSON.parse(record.body) as { name: string; alias: string };
      if (this.organizations.has(body.alias)) return send(409, { errorMessage: "exists" });
      this.organizations.set(body.alias, { id: `kc-org-${this.organizations.size + 1}`, alias: body.alias, name: body.name });
      return send(201);
    }
    const scoped = new RegExp(`^${base}/organizations/([^/]+)/(.*)$`).exec(path);
    const orgId = scoped?.[1] ?? "";
    const rest = scoped?.[2] ?? "";
    if (!scoped || ![...this.organizations.values()].some((org) => org.id === orgId)) return send(404, { error: "unknown" });
    const state = this.stateOf(orgId);
    if (record.method === "POST" && rest === "members") {
      const userId = JSON.parse(record.body) as string;
      if (state.members.has(userId)) return send(409, { errorMessage: "already a member" });
      state.members.add(userId);
      return send(201);
    }
    if (record.method === "DELETE" && rest.startsWith("members/")) {
      return send(state.members.delete(rest.split("/").pop() ?? "") ? 204 : 404);
    }
    // Organization groups (admin REST API of Keycloak 26.6 and later): top-level groups of one organization.
    if (record.method === "GET" && rest === "groups") {
      return send(200, [...state.groups].map(([name, id]) => ({ id, name })));
    }
    if (record.method === "POST" && rest === "groups") {
      const { name } = JSON.parse(record.body) as { name: string };
      if (state.groups.has(name)) return send(409, { errorMessage: "exists" });
      state.groups.set(name, groupId(orgId, name));
      return send(201);
    }
    // The groups of one member: 404 for a user that is not a member of the organization (OrganizationMemberResource).
    const memberGroups = /^members\/([^/]+)\/groups$/.exec(rest);
    if (record.method === "GET" && memberGroups) {
      const userId = memberGroups[1] ?? "";
      if (!state.members.has(userId)) return send(404, { error: "not a member of the organization" });
      const inGroups = [...state.groups].filter(([, id]) => state.groupMembers.get(id)?.has(userId));
      return send(200, inGroups.map(([name, id]) => ({ id, name, path: `/${name}` })));
    }
    // Like Keycloak 26.8.2 (OrganizationGroupResource): a join of a group the user is in answers 409, a leave of a group
    // the user is not in answers 400. Neither is idempotent.
    const membership = /^groups\/([^/]+)\/members\/([^/]+)$/.exec(rest);
    if (membership && (record.method === "PUT" || record.method === "DELETE")) {
      const [, wantedGroup = "", userId = ""] = membership;
      if (![...state.groups.values()].includes(wantedGroup)) return send(404, { error: "no such group" });
      const set = state.groupMembers.get(wantedGroup) ?? new Set<string>();
      state.groupMembers.set(wantedGroup, set);
      if (record.method === "PUT") {
        if (this.refuseGroupJoinWith !== null) return send(this.refuseGroupJoinWith, { errorMessage: "refused" });
        if (set.has(userId) || this.raceOnGroupJoin) {
          set.add(userId);
          this.raceOnGroupJoin = false;
          return send(409, { errorMessage: "User is already a member of the group" });
        }
        set.add(userId);
        return send(204);
      }
      if (!set.has(userId)) return send(400, { errorMessage: "User not a member" });
      set.delete(userId);
      return send(204);
    }
    return send(404, { error: "unknown" });
  }
}

describe("KeycloakIdentityProvider", () => {
  const keycloak = new FakeKeycloak();
  let nowMs = 1_000_000;

  const create = (overrides: Partial<KeycloakOptions> = {}) =>
    new KeycloakIdentityProvider({
      baseUrl: keycloak.url,
      realm: "chance",
      clientId: "tenants",
      clientSecret: "not-a-real-secret",
      retryInitialDelayMs: 1,
      retryMaxDelayMs: 5,
      nowMs: () => nowMs,
      ...overrides,
    });

  beforeAll(async () => {
    await keycloak.start();
  });

  afterAll(async () => {
    await keycloak.stop();
  });

  beforeEach(() => {
    keycloak.requests.length = 0;
    keycloak.organizations.clear();
    keycloak.states.clear();
    keycloak.raceOnGroupJoin = false;
    keycloak.refuseGroupJoinWith = null;
    keycloak.failWith = [];
    keycloak.hang = false;
    keycloak.rejectTokenOnce = false;
    keycloak.tokenLifetime = 300;
    keycloak.tokenStatus = 200;
    nowMs = 1_000_000;
  });

  afterEach(() => {
    keycloak.hang = false;
  });

  it("asks for a client-credentials token once and caches it until shortly before it expires", async () => {
    const idp = create();

    await idp.ensureOrganization(TENANT, "Acme");
    await idp.ensureOrganization(TENANT, "Acme");

    expect(keycloak.count("POST", /openid-connect\/token$/)).toBe(1);
    const token = keycloak.requests.find((r) => r.path.endsWith("/token"));
    expect(new URLSearchParams(token?.body).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(token?.body).get("client_id")).toBe("tenants");
    expect(keycloak.requests.filter((r) => r.path.includes("/admin/")).every((r) => r.authorization === "Bearer token-1")).toBe(true);

    nowMs += 300_000 - 29_000; // inside the 30 s safety margin before expiry
    await idp.ensureOrganization(TENANT, "Acme");
    expect(keycloak.count("POST", /openid-connect\/token$/)).toBe(2);
    expect(keycloak.requests.at(-1)?.authorization).toBe("Bearer token-2");
  });

  it("asks for a new token when the cached one is rejected", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    keycloak.rejectTokenOnce = true;

    await idp.ensureOrganization(TENANT, "Acme");

    expect(keycloak.count("POST", /openid-connect\/token$/)).toBe(2);
  });

  it("looks for the organization by exact search before it creates one", async () => {
    const idp = create();

    await idp.ensureOrganization(TENANT, "Acme Ltd");
    await idp.ensureOrganization(TENANT, "Acme Ltd");

    const searches = keycloak.requests.filter((r) => r.method === "GET" && r.path.endsWith("/organizations"));
    // The first call looks, creates and reads the organization back; the second only looks.
    expect(searches).toHaveLength(3);
    expect(searches[0]?.query.get("exact")).toBe("true");
    expect(searches[0]?.query.get("search")).toBe(TENANT);
    expect(keycloak.count("POST", /\/organizations$/)).toBe(1);
    const created = JSON.parse(keycloak.requests.find((r) => r.method === "POST" && r.path.endsWith("/organizations"))?.body ?? "{}") as Record<string, unknown>;
    expect(created).toEqual({ name: TENANT, alias: TENANT, description: "Acme Ltd", enabled: true });
  });

  it("treats a member that already exists as success", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");

    await idp.addMember(TENANT, USER);
    await idp.addMember(TENANT, USER);

    expect(keycloak.count("POST", /members$/)).toBe(2);
    expect(JSON.parse(keycloak.requests.find((r) => r.path.endsWith("/members"))?.body ?? "")).toBe(USER);
    expect(keycloak.members.has(USER)).toBe(true);
  });

  it("passes on an organization that is missing for addMember as it is: that is neither an outage nor a refusal", async () => {
    const failure: unknown = await create().addMember(TENANT, USER).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(IdentityProviderUnavailable);
    expect(failure).not.toBeInstanceOf(IdentityProviderRejected);
    expect((failure as Error).message).toContain("does not exist");
  });

  it("creates the two role groups of an organization, also for one that exists without them, and creates them once", async () => {
    const idp = create();

    await idp.ensureOrganization(TENANT, "Acme");
    expect([...keycloak.groups.keys()].sort()).toEqual(["tenant-admin", "trader"]);
    expect(keycloak.count("POST", /\/groups$/)).toBe(2);
    expect(keycloak.requests.filter((r) => r.method === "POST" && r.path.endsWith("/groups")).map((r) => JSON.parse(r.body))).toEqual([
      { name: "trader" },
      { name: "tenant-admin" },
    ]);

    await idp.ensureOrganization(TENANT, "Acme");
    expect(keycloak.count("POST", /\/groups$/)).toBe(2);

    // One group was deleted behind our back: it is made again, the other one is left alone.
    keycloak.groups.delete("trader");
    await idp.ensureOrganization(TENANT, "Acme");
    expect(keycloak.count("POST", /\/groups$/)).toBe(3);
  });

  it("puts a member in exactly one role group of the organization: adds the wanted group, then leaves the other", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    await idp.addMember(TENANT, USER);
    keycloak.requests.length = 0;

    await idp.setRole(TENANT, USER, "tenant-admin");
    await idp.setRole(TENANT, USER, "trader");

    const changes = keycloak.requests.filter((r) => r.path.includes("/groups/")).map((r) => `${r.method} ${r.path.split("/groups/")[1]}`);
    // The user is in no group at first, so there is nothing to leave; the second change joins one and leaves the other.
    expect(changes).toEqual([
      `PUT ${groupId(ORG_ID, "tenant-admin")}/members/${USER}`,
      `PUT ${groupId(ORG_ID, "trader")}/members/${USER}`,
      `DELETE ${groupId(ORG_ID, "tenant-admin")}/members/${USER}`,
    ]);
    expect([...(keycloak.groupMembers.get(groupId(ORG_ID, "trader")) ?? [])]).toEqual([USER]);
    expect([...(keycloak.groupMembers.get(groupId(ORG_ID, "tenant-admin")) ?? [])]).toEqual([]);
    // Never a realm role mapping, never a role on a group, never the platform-admin role.
    const everything = JSON.stringify(keycloak.requests);
    expect(everything).not.toContain("role-mappings");
    expect(everything).not.toContain("platform-admin");
  });

  it("sets the same role again without a single change: Keycloak answers 409 to a join of a group the user is in", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    await idp.addMember(TENANT, USER);
    await idp.setRole(TENANT, USER, "trader");
    keycloak.requests.length = 0;

    await idp.setRole(TENANT, USER, "trader");

    expect(keycloak.requests.filter((r) => r.method === "PUT" || r.method === "DELETE")).toEqual([]);
    expect(keycloak.requests.some((r) => r.method === "GET" && r.path.endsWith(`/members/${USER}/groups`))).toBe(true);
    expect([...(keycloak.groupMembers.get(groupId(ORG_ID, "trader")) ?? [])]).toEqual([USER]);
  });

  it("takes a 409 on the join as success: another run put the user in the group between the read and the join", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    await idp.addMember(TENANT, USER);
    keycloak.raceOnGroupJoin = true;

    await idp.setRole(TENANT, USER, "trader");

    expect([...(keycloak.groupMembers.get(groupId(ORG_ID, "trader")) ?? [])]).toEqual([USER]);
  });

  it("does not hide a refusal of the join other than 409", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    await idp.addMember(TENANT, USER);
    keycloak.refuseGroupJoinWith = 403;

    const failure: unknown = await idp.setRole(TENANT, USER, "trader").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IdentityProviderRejected);
    expect((failure as IdentityProviderRejected).status).toBe(403);
    expect([...(keycloak.groupMembers.get(groupId(ORG_ID, "trader")) ?? [])]).toEqual([]);
  });

  it("reconciles a user whose first organization is synced when a second one joins, and again, without a failure", async () => {
    const core = createCore();
    const idp = create();
    const reconcile = new ReconcileIdentity({ store: core.store, identity: idp });
    const acme = await core.useCases.createTenant.execute({ name: "Acme Ltd", slug: "acme", caller: caller("platform-1") });
    const beta = await core.useCases.createTenant.execute({ name: "Beta Ltd", slug: "beta", caller: caller("platform-1") });
    await core.useCases.acceptInvite.execute({ code: acme.adminInvite.code, caller: caller(USER) });

    await reconcile.execute({ kind: "member", target: USER }); // one membership, synced
    await core.useCases.acceptInvite.execute({ code: beta.adminInvite.code, caller: caller(USER) });
    await reconcile.execute({ kind: "member", target: USER }); // the first one again, then the second
    await reconcile.execute({ kind: "member", target: USER }); // a retry of the same item

    const second = "kc-org-2";
    expect([...keycloak.organizations.values()].map((org) => org.id).sort()).toEqual([ORG_ID, second]);
    for (const orgId of [ORG_ID, second]) {
      expect([...(keycloak.stateOf(orgId).groupMembers.get(groupId(orgId, "tenant-admin")) ?? [])]).toEqual([USER]);
      expect([...(keycloak.stateOf(orgId).groupMembers.get(groupId(orgId, "trader")) ?? [])]).toEqual([]);
    }
    // One join per organization in all three runs, and nothing was ever left.
    expect(keycloak.requests.filter((r) => r.method === "PUT" && r.path.includes("/groups/"))).toHaveLength(2);
    expect(keycloak.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
    expect(acme.tenant.id).not.toBe(beta.tenant.id);
  });

  it("does not touch the groups of another organization", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    await idp.addMember(TENANT, USER);
    keycloak.requests.length = 0;

    await idp.setRole(TENANT, USER, "trader");

    expect(keycloak.requests.every((r) => !r.path.includes("/users/") && (r.path.includes(`/organizations/${ORG_ID}`) || r.path.endsWith("/organizations") || r.path.endsWith("/token")))).toBe(true);
  });

  it("retries a 503 and succeeds", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    keycloak.requests.length = 0;
    keycloak.failWith = [503, 503];

    await idp.addMember(TENANT, USER);

    expect(keycloak.count("GET", /\/organizations$/)).toBe(3);
    expect(keycloak.members.has(USER)).toBe(true);
  });

  it("retries a 429 too, but not a 400, a 403 or a 404", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    keycloak.requests.length = 0;
    keycloak.failWith = [429];
    await idp.addMember(TENANT, USER);
    expect(keycloak.count("GET", /\/organizations$/)).toBe(2);

    for (const status of [400, 403, 404]) {
      keycloak.requests.length = 0;
      keycloak.failWith = [status];
      await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderRejected);
      expect(keycloak.count("GET", /\/organizations$/)).toBe(1);
    }
  });

  it("reports an answer that refuses as IdentityProviderRejected with its status, in every operation", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    await idp.addMember(TENANT, USER);

    for (const status of [400, 403, 404]) {
      keycloak.failWith = [status];
      await expect(idp.ensureOrganization(TENANT, "Acme")).rejects.toMatchObject({ name: "IdentityProviderRejected", status });
      keycloak.failWith = [status];
      await expect(idp.addMember(TENANT, USER)).rejects.toMatchObject({ name: "IdentityProviderRejected", status });
      keycloak.failWith = [status];
      const setRole = await idp.setRole(TENANT, USER, "tenant-admin").catch((error: unknown) => error);
      expect(setRole).toBeInstanceOf(IdentityProviderRejected);
      expect((setRole as IdentityProviderRejected).status).toBe(status);
      expect((setRole as IdentityProviderRejected).message).toContain(`HTTP ${status}`);
    }
  });

  it("reports a 401 that a fresh token does not fix as rejected", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme"); // caches a token
    keycloak.requests.length = 0;
    keycloak.failWith = [401, 401];

    // The first 401 may mean that the cached token was revoked: a new token is fetched and the call is repeated.
    // The second one is a refusal.
    await expect(idp.ensureOrganization(TENANT, "Acme")).rejects.toMatchObject({ name: "IdentityProviderRejected", status: 401 });
    expect(keycloak.count("POST", /openid-connect\/token$/)).toBe(1);
    expect(keycloak.count("GET", /\/organizations$/)).toBe(2);
  });

  it("does not let refusals open the circuit: only failures that may pass count", async () => {
    const idp = create({ breakerThreshold: 3, maxAttempts: 1, halfOpenAfterMs: 60_000 });
    await idp.ensureOrganization(TENANT, "Acme");

    for (let n = 0; n < 6; n += 1) {
      keycloak.failWith = [403];
      await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderRejected);
    }
    await idp.addMember(TENANT, USER);

    expect(keycloak.members.has(USER)).toBe(true);
  });

  it("reports 429 and 5xx that outlast the retries as unavailable, not as rejected", async () => {
    const idp = create({ breakerThreshold: 100 });
    await idp.ensureOrganization(TENANT, "Acme");

    for (const status of [429, 500, 502, 503]) {
      keycloak.failWith = [status, status, status];
      const failure: unknown = await idp.addMember(TENANT, USER).catch((error: unknown) => error);
      expect(failure, String(status)).toBeInstanceOf(IdentityProviderUnavailable);
      expect(failure).not.toBeInstanceOf(IdentityProviderRejected);
    }
  });

  it("gives up after three attempts and reports the provider as unavailable", async () => {
    const idp = create();
    await idp.ensureOrganization(TENANT, "Acme");
    keycloak.requests.length = 0;
    keycloak.failWith = [500, 500, 500, 500];

    await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderUnavailable);
    expect(keycloak.count("GET", /\/organizations$/)).toBe(3);
  });

  it("opens the circuit after five consecutive failures and then fails without calling the server", async () => {
    const idp = create({ halfOpenAfterMs: 60_000 });
    await idp.ensureOrganization(TENANT, "Acme");
    keycloak.requests.length = 0;
    keycloak.failWith = Array.from({ length: 50 }, () => 503);

    await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderUnavailable); // 3 failures
    await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderUnavailable); // 2 more: open
    const callsWhenOpen = keycloak.requests.length;
    expect(callsWhenOpen).toBe(5);

    // An open circuit is "unavailable" too, not a refusal, although no answer came back.
    await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderUnavailable);
    await expect(idp.setRole(TENANT, USER, "trader")).rejects.toBeInstanceOf(IdentityProviderUnavailable);
    expect(keycloak.requests).toHaveLength(callsWhenOpen);
  });

  it("closes the circuit again after the half-open wait when the server answers", async () => {
    const idp = create({ halfOpenAfterMs: 30, breakerThreshold: 2, maxAttempts: 1 });
    await idp.ensureOrganization(TENANT, "Acme");
    keycloak.failWith = [503, 503];
    await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderUnavailable);
    await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderUnavailable);
    await new Promise((resolve) => setTimeout(resolve, 60));

    await idp.addMember(TENANT, USER);

    expect(keycloak.members.has(USER)).toBe(true);
  });

  it("times out a call that gets no answer", async () => {
    const idp = create({ timeoutMs: 80, maxAttempts: 1 });
    await idp.ensureOrganization(TENANT, "Acme");
    keycloak.hang = true;

    const started = Date.now();
    await expect(idp.addMember(TENANT, USER)).rejects.toBeInstanceOf(IdentityProviderUnavailable);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("reports an unreachable server as unavailable", async () => {
    const idp = create({ baseUrl: "http://127.0.0.1:1", maxAttempts: 2 });
    const failure: unknown = await idp.ensureOrganization(TENANT, "Acme").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityProviderUnavailable);
    expect(failure).not.toBeInstanceOf(IdentityProviderRejected);
  });

  it("reports a refused client secret (the token endpoint answers 401) as rejected", async () => {
    keycloak.tokenStatus = 401;
    const failure: unknown = await create().ensureOrganization(TENANT, "Acme").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IdentityProviderRejected);
    expect((failure as IdentityProviderRejected).status).toBe(401);
  });
});
