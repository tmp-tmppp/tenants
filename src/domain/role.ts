import { DomainError } from "./errors.js";

// The two roles a membership can have. "platform-admin" is a platform-wide role of the identity provider,
// not a membership role, and this service never sets it.
export const ROLES = ["trader", "tenant-admin"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function parseRole(value: unknown, field = "role"): Role {
  if (!isRole(value)) throw new DomainError("invalid_role", `Role must be one of: ${ROLES.join(", ")}`, field);
  return value;
}
