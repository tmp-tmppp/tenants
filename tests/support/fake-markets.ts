import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import type { ShareAdmission, ShareAdmissionOutcome, ShareAdmissionRequest, ShareLinkType } from "../../src/usecases/ports.js";

// markets' admission endpoint as the agreed contract describes it (contracts/markets-admission.openapi.yaml). The fake
// checks every request it receives against the request schema and every answer it gives against the response schema, so
// tenants and the real endpoint of markets cannot drift apart unnoticed: a shape that is not in the file fails here.
const contract = parse(readFileSync(new URL("../../contracts/markets-admission.openapi.yaml", import.meta.url), "utf8")) as Record<string, any>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
const schema = (name: string) => ajv.compile({ components: contract["components"], $ref: `#/components/schemas/${name}` });
const validRequest = schema("AdmissionRequest");
const validResponse = schema("AdmissionResponse");

export interface FakeLink {
  linkType: ShareLinkType;
  tenantId: string;
  marketId: string;
  /** For links of type "profiles": the e-mail addresses on the list (compared case-insensitively). */
  emails?: string[];
  revoked?: boolean;
}

/** A markets that knows the share links given to it, and decides as the contract says. */
export class FakeMarkets implements ShareAdmission {
  readonly links = new Map<string, FakeLink>();
  /** Every request it received, as sent. */
  readonly requests: ShareAdmissionRequest[] = [];
  /** When set, the next calls answer "unavailable" with this reason. */
  failWith: string | null = null;

  admit(request: ShareAdmissionRequest): Promise<ShareAdmissionOutcome> {
    this.requests.push(request);
    if (!validRequest(request)) {
      throw new Error(`The request does not match the admission contract: ${JSON.stringify(validRequest.errors)}`);
    }
    if (this.failWith !== null) return Promise.resolve({ kind: "unavailable", reason: this.failWith });
    const link = this.links.get(request.token);
    if (!link || link.revoked) return Promise.resolve({ kind: "not_found" });
    let decision: "join" | "members_only" | "denied";
    if (link.linkType === "everyone") decision = "join";
    else if (link.linkType === "members") decision = "members_only";
    else {
      const listed = request.emailVerified && request.userEmail !== null && (link.emails ?? []).some((email) => email.toLowerCase() === request.userEmail?.toLowerCase());
      decision = listed ? "join" : "denied";
    }
    const answer = { decision, linkType: link.linkType, tenantId: link.tenantId, marketId: link.marketId };
    if (!validResponse(answer)) {
      throw new Error(`The answer does not match the admission contract: ${JSON.stringify(validResponse.errors)}`);
    }
    return Promise.resolve({ kind: "answered", ...answer });
  }
}

/** A share-link token of the right shape (43 base64url characters), distinct per number. */
export const shareToken = (n: number): string => `share-token-${String(n).padStart(8, "0")}`.padEnd(43, "x");
