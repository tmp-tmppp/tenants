import { describe, expect, it } from "vitest";
import { ShareJoin } from "../../src/usecases/share-join.js";
import { eventErrors } from "../support/contracts.js";
import { shareToken } from "../support/fake-markets.js";
import type { FakeLink } from "../support/fake-markets.js";
import { caller, createCore, storeFailingAtCommit } from "../support/harness.js";

const MARKET = "018f3c1e-7a00-7000-8000-0000000000bb";
const TOKEN = shareToken(1);
const joinedEvents = <T extends { type: string }>(rows: T[]): T[] => rows.filter((row) => row.type.endsWith("MemberJoined.v1"));

async function organizationWithLink(link: Partial<FakeLink> = {}) {
  const core = createCore();
  const { tenant, adminInvite } = await core.useCases.createTenant.execute({ name: "Acme", slug: "acme", caller: caller("platform-1") });
  await core.useCases.acceptInvite.execute({ code: adminInvite.code, caller: caller("owner-1") });
  core.markets.links.set(TOKEN, { linkType: "everyone", tenantId: tenant.id, marketId: MARKET, ...link });
  return { ...core, tenant };
}

const join = (core: Awaited<ReturnType<typeof organizationWithLink>>, userId: string, email: string | null = null, verified = false, n = 1) =>
  core.useCases.shareJoin.execute({ token: TOKEN, email, emailVerified: verified, caller: caller(userId, n) });

describe("ShareJoin", () => {
  it("adds a trader membership for a link for everyone, with the event, the sync item and the market in the answer", async () => {
    const core = await organizationWithLink();

    const result = await join(core, "visitor-1", null, false, 5);

    expect(result).toEqual({ alias: core.tenant.id, tenantId: core.tenant.id, name: "Acme", marketId: MARKET, role: "trader", joined: true });
    const state = core.store.snapshot();
    expect(state.memberships).toContainEqual(expect.objectContaining({ tenantId: core.tenant.id, userId: "visitor-1", role: "trader" }));
    const events = joinedEvents(state.outbox).filter((row) => row.aggregateId === "visitor-1");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ data: { userId: "visitor-1", role: "trader", via: "share_link", marketId: MARKET }, correlationid: "corr-5" });
    expect(eventErrors("MemberJoinedEvent", events[0]?.payload)).toEqual([]);
    expect(state.identitySync).toContainEqual(expect.objectContaining({ key: "member/visitor-1" }));
    expect(core.identity.calls).toEqual([]);
  });

  it("sends markets the token, the e-mail and the verified flag as the contract says, and logs and stores no token", async () => {
    const core = await organizationWithLink();

    await join(core, "visitor-1", "Visitor@Example.com", true);

    expect(core.markets.requests).toEqual([{ token: TOKEN, userEmail: "Visitor@Example.com", emailVerified: true }]);
    const everything = JSON.stringify([core.logger.lines, core.store.snapshot()]);
    expect(everything).not.toContain(TOKEN);
  });

  it("never gives the admin role, whatever the link", async () => {
    const core = await organizationWithLink({ linkType: "profiles", emails: ["boss@example.com"] });
    const result = await join(core, "boss-1", "boss@example.com", true);
    expect(result.role).toBe("trader");
  });

  describe("a link for chosen profiles", () => {
    const profiles = { linkType: "profiles", emails: ["listed@example.com"] } satisfies Partial<FakeLink>;

    it("admits a listed, verified e-mail address (compared case-insensitively)", async () => {
      const core = await organizationWithLink(profiles);
      await expect(join(core, "u-1", "LISTED@example.com", true)).resolves.toMatchObject({ joined: true, role: "trader" });
    });

    it("answers 403 for an address that is not listed, writing nothing", async () => {
      const core = await organizationWithLink(profiles);
      const before = core.store.snapshot();
      await expect(join(core, "u-1", "other@example.com", true)).rejects.toMatchObject({ kind: "forbidden", code: "share_link_not_permitted" });
      expect(core.store.snapshot()).toEqual(before);
    });

    it("answers 403 for a listed address that is not verified, and for a token without an address", async () => {
      const core = await organizationWithLink(profiles);
      await expect(join(core, "u-1", "listed@example.com", false)).rejects.toMatchObject({ code: "share_link_not_permitted" });
      await expect(join(core, "u-1", null, false)).rejects.toMatchObject({ code: "share_link_not_permitted" });
      expect(core.store.snapshot().memberships.filter((row) => row.userId === "u-1")).toEqual([]);
    });
  });

  describe("a link for members only", () => {
    it("answers 403 to a user who is not a member and writes nothing", async () => {
      const core = await organizationWithLink({ linkType: "members" });
      const before = core.store.snapshot();
      await expect(join(core, "visitor-1")).rejects.toMatchObject({ kind: "forbidden", code: "share_link_members_only" });
      expect(core.store.snapshot()).toEqual(before);
    });

    it("lets a member in: the answer holds the market and the role, and nothing is written", async () => {
      const core = await organizationWithLink({ linkType: "members" });
      const before = core.store.snapshot();
      await expect(join(core, "owner-1")).resolves.toEqual({
        alias: core.tenant.id,
        tenantId: core.tenant.id,
        name: "Acme",
        marketId: MARKET,
        role: "tenant-admin",
        joined: false,
      });
      expect(core.store.snapshot()).toEqual(before);
    });
  });

  it("is idempotent: a second join of the same user answers with the membership and writes nothing", async () => {
    const core = await organizationWithLink();
    await join(core, "visitor-1");
    const before = core.store.snapshot();

    await expect(join(core, "visitor-1")).resolves.toMatchObject({ joined: false, role: "trader", marketId: MARKET });

    expect(core.store.snapshot()).toEqual(before);
  });

  it("keeps the role of a member who is an admin, and lets a user of another organization join this one too", async () => {
    const core = await organizationWithLink();
    await expect(join(core, "owner-1")).resolves.toMatchObject({ joined: false, role: "tenant-admin" });
    const other = await core.useCases.createTenant.execute({ name: "Other", slug: "other", caller: caller("platform-1") });
    await core.useCases.acceptInvite.execute({ code: other.adminInvite.code, caller: caller("visitor-1") });

    await expect(join(core, "visitor-1")).resolves.toMatchObject({ joined: true, role: "trader", alias: core.tenant.id });

    const own = core.store.snapshot().memberships.filter((row) => row.userId === "visitor-1");
    expect(own.map((row) => [row.tenantId, row.role]).sort()).toEqual([[other.tenant.id, "tenant-admin"], [core.tenant.id, "trader"]].sort());
    expect(core.store.snapshot().identitySync.filter((row) => row.key === "member/visitor-1")).toHaveLength(1);
  });

  it("answers 404 for an unknown, a revoked and an expired link alike", async () => {
    const core = await organizationWithLink({ revoked: true });
    await expect(join(core, "u-1")).rejects.toMatchObject({ kind: "not_found", code: "share_link_not_found" });
    await expect(
      core.useCases.shareJoin.execute({ token: shareToken(99), email: null, emailVerified: false, caller: caller("u-1") }),
    ).rejects.toMatchObject({ kind: "not_found", code: "share_link_not_found" });
  });

  it("answers 503 when markets cannot be asked, writes nothing and logs the reason without the token", async () => {
    const core = await organizationWithLink();
    core.markets.failWith = "TimeoutError";
    const before = core.store.snapshot();

    await expect(join(core, "u-1")).rejects.toMatchObject({ kind: "unavailable", code: "market_service_unavailable" });

    expect(core.store.snapshot()).toEqual(before);
    expect(core.logger.lines).toEqual([expect.objectContaining({ level: "warn", fields: { reason: "TimeoutError" } })]);
    expect(JSON.stringify(core.logger.lines)).not.toContain(TOKEN);
  });

  it("answers 404 and logs an error when markets names an organization this registry does not know", async () => {
    const core = await organizationWithLink({ tenantId: "00000000-0000-7000-8000-00000000ffff" });
    await expect(join(core, "u-1")).rejects.toMatchObject({ kind: "not_found", code: "share_link_not_found" });
    expect(core.logger.lines.filter((line) => line.level === "error")).toHaveLength(1);
    expect(JSON.stringify(core.logger.lines)).not.toContain(TOKEN);
  });

  it("answers two simultaneous joins of the same user with one membership and one event", async () => {
    const core = await organizationWithLink();

    const results = await Promise.all([join(core, "visitor-1", null, false, 1), join(core, "visitor-1", null, false, 2)]);

    expect(results.map((result) => result.joined).sort()).toEqual([false, true]);
    const state = core.store.snapshot();
    expect(state.memberships.filter((row) => row.userId === "visitor-1")).toHaveLength(1);
    expect(joinedEvents(state.outbox).filter((row) => row.aggregateId === "visitor-1")).toHaveLength(1);
  });

  it("does not hide a failure that is not a repeat join", async () => {
    const core = await organizationWithLink();
    const failing = new ShareJoin({ ...core.deps, store: storeFailingAtCommit(core.store) }, core.markets);

    await expect(failing.execute({ token: TOKEN, email: null, emailVerified: false, caller: caller("u-1") })).rejects.toThrow("database is down");
    expect(core.store.snapshot().memberships.filter((row) => row.userId === "u-1")).toEqual([]);
  });
});
