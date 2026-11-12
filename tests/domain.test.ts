import { describe, expect, it } from "vitest";
import { DomainError } from "../src/domain/errors.js";
import {
  eventType,
  memberJoinedEvent,
  memberRoleChangedEvent,
  natsSubject,
  tenantCreatedEvent,
} from "../src/domain/events.js";
import { assertInviteUsable, hashInviteCode, newInvite } from "../src/domain/invite.js";
import { assertAdminRemains, newMembership } from "../src/domain/membership.js";
import { isRole, parseRole } from "../src/domain/role.js";
import { newTenant, validateName, validateSlug } from "../src/domain/tenant.js";

const now = new Date("2026-11-01T10:00:00.000Z");

describe("slug", () => {
  it.each(["abc", "acme-corp", "a1b", "x".repeat(40), "0-0", "team-42"])("accepts %s", (slug) => {
    expect(validateSlug(slug)).toBe(slug);
  });

  it.each(["", "ab", "x".repeat(41), "-abc", "abc-", "ABC", "acme corp", "acme_corp", "ačme", "a--"])(
    "rejects %j",
    (slug) => {
      expect(() => validateSlug(slug)).toThrowError(DomainError);
      try {
        validateSlug(slug);
      } catch (error) {
        expect((error as DomainError).code).toBe("invalid_slug");
        expect((error as DomainError).field).toBe("slug");
      }
    },
  );
});

describe("name and tenant", () => {
  it("trims the name and rejects an empty or a too long one", () => {
    expect(validateName("  Acme  ")).toBe("Acme");
    expect(() => validateName("   ")).toThrowError(DomainError);
    expect(() => validateName("x".repeat(101))).toThrowError(DomainError);
    expect(validateName("x".repeat(100))).toBe("x".repeat(100));
  });

  it("trims every kind of surrounding whitespace, also tabs and line breaks", () => {
    expect(validateName("\t Acme Ltd \n")).toBe("Acme Ltd");
  });

  it.each([
    ["NUL", "Acme\u0000Ltd"],
    ["a leading NUL", "\u0000Acme"],
    ["a trailing NUL", "Acme\u0000"],
    ["a tab inside", "Acme\tLtd"],
    ["a line break inside", "Acme\nLtd"],
    ["escape", "Acme\u001bLtd"],
    ["DEL", "Acme\u007fLtd"],
    ["a C1 control", "Acme\u0085Ltd"],
    ["a lone high surrogate", "Acme\ud800"],
    ["a lone low surrogate", "\udc00Acme"],
    ["a lone surrogate inside", "Ac\ud83cme"],
    ["a reversed pair", "Acme\udf6b\ud83c"],
  ])("rejects a name with %s", (_label, name) => {
    try {
      validateName(name);
      expect.unreachable("the name should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "invalid_name", field: "name" });
    }
  });

  it("keeps ordinary letters, spaces and symbols, also outside ASCII", () => {
    expect(validateName("Čokoladnica d.o.o. – Šmarje 🍫")).toBe("Čokoladnica d.o.o. – Šmarje 🍫");
  });

  it("keeps a surrogate pair that is written out as two halves, and says what is wrong with a lone one", () => {
    expect(validateName("Acme \ud83c\udf6b")).toBe("Acme 🍫");
    expect(() => validateName("Acme\ud800")).toThrowError("Name must be valid text: no unpaired surrogate characters");
  });

  it("creates an active tenant", () => {
    const tenant = newTenant({ id: "t-1", name: "Acme", slug: "acme", createdBy: "admin", now });
    expect(tenant).toMatchObject({ id: "t-1", name: "Acme", slug: "acme", status: "active", createdBy: "admin", createdAt: now });
  });
});

describe("role", () => {
  it("knows exactly trader and tenant-admin", () => {
    expect(isRole("trader")).toBe(true);
    expect(isRole("tenant-admin")).toBe(true);
    expect(isRole("platform-admin")).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(() => parseRole("platform-admin")).toThrowError(DomainError);
  });
});

describe("invite", () => {
  const make = (overrides: Partial<Parameters<typeof newInvite>[0]> = {}) =>
    newInvite({
      code: "secret-code-0000001",
      tenantId: "t-1",
      role: "trader",
      maxUses: 2,
      expiresInHours: 24,
      createdBy: "admin",
      now,
      ...overrides,
    });

  it("stores the SHA-256 hash of the code, never the code", () => {
    const invite = make();
    expect(invite.codeHash).toBe(hashInviteCode("secret-code-0000001"));
    expect(invite.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(invite)).not.toContain("secret-code-0000001");
    // Known value of SHA-256("abc").
    expect(hashInviteCode("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("expires after the given hours", () => {
    expect(make().expiresAt.toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });

  it("is usable before it expires and unusable at the moment it expires", () => {
    const invite = make();
    expect(() => assertInviteUsable(invite, new Date(invite.expiresAt.getTime() - 1))).not.toThrow();
    expect(() => assertInviteUsable(invite, invite.expiresAt)).toThrowError(expect.objectContaining({ code: "invite_expired" }));
  });

  it("is unusable when all uses are spent", () => {
    const spent = { ...make(), uses: 2 };
    expect(() => assertInviteUsable(spent, now)).toThrowError(expect.objectContaining({ code: "invite_used_up" }));
    expect(() => assertInviteUsable({ ...spent, uses: 1 }, now)).not.toThrow();
  });

  it.each([0, 101, 1.5])("rejects maxUses %s", (maxUses) => {
    expect(() => make({ maxUses })).toThrowError(expect.objectContaining({ code: "invalid_limit", field: "maxUses" }));
  });

  it.each([0, 721, 2.5])("rejects expiresInHours %s", (expiresInHours) => {
    expect(() => make({ expiresInHours })).toThrowError(expect.objectContaining({ code: "invalid_limit", field: "expiresInHours" }));
  });
});

describe("last admin rule", () => {
  it("refuses to demote the only admin", () => {
    expect(() => assertAdminRemains("tenant-admin", "trader", 1)).toThrowError(expect.objectContaining({ code: "last_admin" }));
  });

  it("allows a demotion while another admin remains, and every other change", () => {
    expect(() => assertAdminRemains("tenant-admin", "trader", 2)).not.toThrow();
    expect(() => assertAdminRemains("trader", "tenant-admin", 0)).not.toThrow();
    expect(() => assertAdminRemains("tenant-admin", "tenant-admin", 1)).not.toThrow();
    expect(() => assertAdminRemains("trader", "trader", 1)).not.toThrow();
  });

  it("creates a membership with equal join and update times", () => {
    const membership = newMembership({ tenantId: "t-1", userId: "u-1", role: "trader", now });
    expect(membership.joinedAt).toEqual(membership.updatedAt);
  });
});

describe("integration events", () => {
  const ctx = { eventId: "00000000-0000-7000-8000-000000000001", now, correlationId: "corr-1", causationId: "req-1" };

  it("builds a valid CloudEvent for TenantCreated", () => {
    const event = tenantCreatedEvent({ id: "t-1", name: "Acme", slug: "acme", createdAt: now }, ctx);
    expect(event).toEqual({
      specversion: "1.0",
      id: ctx.eventId,
      source: "/chance/tenants",
      type: "si.chance.tenants.TenantCreated.v1",
      subject: "tenant/t-1",
      time: "2026-11-01T10:00:00.000Z",
      datacontenttype: "application/json",
      tenantid: "t-1",
      correlationid: "corr-1",
      causationid: "req-1",
      data: { tenantId: "t-1", name: "Acme", slug: "acme", createdAt: "2026-11-01T10:00:00.000Z" },
    });
  });

  it("builds MemberJoined and MemberRoleChanged with ids only", () => {
    const joined = memberJoinedEvent({ tenantId: "t-1", userId: "u-1", role: "trader", joinedAt: now }, ctx);
    expect(joined.type).toBe("si.chance.tenants.MemberJoined.v1");
    expect(joined.subject).toBe("member/u-1");
    expect(joined.data).toEqual({ tenantId: "t-1", userId: "u-1", role: "trader", joinedAt: "2026-11-01T10:00:00.000Z" });

    const changed = memberRoleChangedEvent(
      { tenantId: "t-1", userId: "u-1", oldRole: "trader", newRole: "tenant-admin", changedBy: "admin", changedAt: now },
      ctx,
    );
    expect(changed.type).toBe("si.chance.tenants.MemberRoleChanged.v1");
    expect(changed.data).toEqual({
      tenantId: "t-1",
      userId: "u-1",
      oldRole: "trader",
      newRole: "tenant-admin",
      changedBy: "admin",
      changedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(changed.tenantid).toBe("t-1");
  });

  it("names types and NATS subjects", () => {
    expect(eventType("MemberJoined")).toBe("si.chance.tenants.MemberJoined.v1");
    expect(natsSubject("TenantCreated", "t-1")).toBe("chance.tenants.TenantCreated.t-1");
  });
});
