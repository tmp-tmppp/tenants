import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import type { Role } from "./role.js";

export const INVITE_MAX_USES = 100;
export const INVITE_MAX_TTL_HOURS = 720;

export interface InviteCode {
  /** SHA-256 hex of the code. The code itself is shown once, at creation, and never stored. */
  readonly codeHash: string;
  readonly tenantId: string;
  readonly role: Role;
  readonly maxUses: number;
  readonly uses: number;
  readonly expiresAt: Date;
  readonly createdBy: string;
  readonly createdAt: Date;
}

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function newInvite(input: {
  code: string;
  tenantId: string;
  role: Role;
  maxUses: number;
  expiresInHours: number;
  createdBy: string;
  now: Date;
}): InviteCode {
  if (!Number.isInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > INVITE_MAX_USES) {
    throw new DomainError("invalid_limit", `maxUses must be an integer from 1 to ${INVITE_MAX_USES}`, "maxUses");
  }
  if (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1 || input.expiresInHours > INVITE_MAX_TTL_HOURS) {
    throw new DomainError(
      "invalid_limit",
      `expiresInHours must be an integer from 1 to ${INVITE_MAX_TTL_HOURS}`,
      "expiresInHours",
    );
  }
  return {
    codeHash: hashInviteCode(input.code),
    tenantId: input.tenantId,
    role: input.role,
    maxUses: input.maxUses,
    uses: 0,
    expiresAt: new Date(input.now.getTime() + input.expiresInHours * 3_600_000),
    createdBy: input.createdBy,
    createdAt: input.now,
  };
}

/** Throws when the invite can no longer be used: expired, or all its uses are spent. */
export function assertInviteUsable(invite: InviteCode, now: Date): void {
  if (now.getTime() >= invite.expiresAt.getTime()) throw new DomainError("invite_expired", "The invite has expired");
  if (invite.uses >= invite.maxUses) throw new DomainError("invite_used_up", "The invite is used up");
}
