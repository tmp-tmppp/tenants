import { DomainError } from "../domain/errors.js";

// Transport-agnostic errors of the use cases. Only src/web maps them to HTTP status codes (GP-6.28).
export type UseCaseErrorKind = "validation" | "not_found" | "conflict" | "gone" | "forbidden" | "unavailable";

export interface FieldError {
  field: string;
  message: string;
}

export class UseCaseError extends Error {
  constructor(
    readonly kind: UseCaseErrorKind,
    /** Stable machine-readable code, for example "slug_taken". */
    readonly code: string,
    message: string,
    readonly fields: readonly FieldError[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationFailed extends UseCaseError {
  constructor(fields: readonly FieldError[], message = "The request is invalid") {
    super("validation", "validation_failed", message, fields);
  }
}

export class NotFound extends UseCaseError {
  constructor(code: string, message: string) {
    super("not_found", code, message);
  }
}

export class Conflict extends UseCaseError {
  constructor(code: string, message: string) {
    super("conflict", code, message);
  }
}

/** The resource existed but cannot be used any more (HTTP 410 at the edge). */
export class Gone extends UseCaseError {
  constructor(code: string, message: string) {
    super("gone", code, message);
  }
}

/** The caller is known but may not do this (HTTP 403 at the edge), for example a share link that is not meant for the caller. */
export class Forbidden extends UseCaseError {
  constructor(code: string, message: string) {
    super("forbidden", code, message);
  }
}

/** A service this one depends on for the request cannot be asked (HTTP 503 at the edge); nothing was changed. */
export class DependencyUnavailable extends UseCaseError {
  constructor(code: string, message: string) {
    super("unavailable", code, message);
  }
}

/**
 * The identity provider could not be reached or is overloaded: a network error, a timeout, an open circuit, 429 or
 * a 5xx answer. Worth retrying soon. Only the identity-sync worker sees it; requests never call the provider.
 */
export class IdentityProviderUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IdentityProviderUnavailable";
  }
}

/**
 * The identity provider answered and refused (HTTP 400, 401, 403, a 404 the call does not accept ...). Retrying
 * does not help until someone fixes the cause, for example a missing permission of the service account.
 */
export class IdentityProviderRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IdentityProviderRejected";
  }
}

/** Turns a rule violation of the domain into the use-case error a caller can act on. */
export function fromDomainError(error: DomainError): UseCaseError {
  switch (error.code) {
    case "invalid_name":
    case "invalid_slug":
    case "invalid_role":
    case "invalid_limit":
      return new ValidationFailed([{ field: error.field ?? "request", message: error.message }]);
    case "invite_expired":
      return new Gone("invite_expired", error.message);
    case "invite_used_up":
      return new Gone("invite_used_up", error.message);
    case "last_admin":
      return new Conflict("last_admin", error.message);
  }
}

/** Runs domain code and reports its rule violations as use-case errors. */
export function guardDomain<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof DomainError) throw fromDomainError(error);
    throw error;
  }
}
