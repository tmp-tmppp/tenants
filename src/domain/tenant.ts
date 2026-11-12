import { DomainError } from "./errors.js";

export type TenantStatus = "active" | "suspended";

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: TenantStatus;
  /** Subject of the platform admin who created the tenant. */
  readonly createdBy: string;
  readonly createdAt: Date;
}

/** Lowercase letters, digits and dashes, 3 to 40 characters, no leading or trailing dash. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const NAME_MAX_LENGTH = 100;
/** Unicode category Cc: the C0 and C1 controls, NUL, tab and line breaks included. PostgreSQL cannot store NUL in text. */
const CONTROL_CHARACTER = /\p{Cc}/u;
/**
 * Unicode category Cs: with the u flag it matches only a lone surrogate (a half of a pair, which JSON can carry as
 * "\ud800"); a proper pair is one code point and does not match. Such a string is not valid text: the database
 * would store a replacement character or refuse it.
 */
const LONE_SURROGATE = /\p{Cs}/u;

export function validateSlug(slug: string): string {
  if (!SLUG_PATTERN.test(slug)) {
    throw new DomainError(
      "invalid_slug",
      "Slug must have 3 to 40 characters: lowercase letters, digits and dashes, no leading or trailing dash",
      "slug",
    );
  }
  return slug;
}

/** Trims surrounding whitespace; 1 to 100 characters, none of them a control character or a lone surrogate. */
export function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) {
    throw new DomainError("invalid_name", `Name must have 1 to ${NAME_MAX_LENGTH} characters`, "name");
  }
  if (CONTROL_CHARACTER.test(trimmed)) {
    throw new DomainError("invalid_name", "Name must not contain control characters", "name");
  }
  if (LONE_SURROGATE.test(trimmed)) {
    throw new DomainError("invalid_name", "Name must be valid text: no unpaired surrogate characters", "name");
  }
  return trimmed;
}

export function newTenant(input: { id: string; name: string; slug: string; createdBy: string; now: Date }): Tenant {
  return {
    id: input.id,
    name: validateName(input.name),
    slug: validateSlug(input.slug),
    status: "active",
    createdBy: input.createdBy,
    createdAt: input.now,
  };
}
