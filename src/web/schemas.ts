import { USER_ID_MAX_LENGTH } from "../usecases/support.js";

// JSON schemas of the routes: they validate the input and shape the output. They mirror contracts/openapi.yaml,
// and tests/contracts compares the routes with that file.
const role = { type: "string", enum: ["trader", "tenant-admin"] } as const;
const uuid = { type: "string", format: "uuid" } as const;
const dateTime = { type: "string", format: "date-time" } as const;
/** A user id (the subject of the identity provider): 1 to 255 characters, no control character (NUL included). */
const userId = { type: "string", minLength: 1, maxLength: USER_ID_MAX_LENGTH, pattern: "^[^\\p{Cc}]+$" } as const;

const fieldError = {
  type: "object",
  properties: { field: { type: "string" }, message: { type: "string" } },
} as const;

export const problemSchema = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    code: { type: "string" },
    errors: { type: "array", items: fieldError },
  },
} as const;

const tenant = {
  type: "object",
  properties: {
    id: uuid,
    name: { type: "string" },
    slug: { type: "string" },
    status: { type: "string", enum: ["active", "suspended"] },
    createdBy: { type: "string" },
    createdAt: dateTime,
  },
} as const;

const invite = {
  type: "object",
  properties: {
    code: { type: "string" },
    role,
    maxUses: { type: "integer" },
    expiresAt: dateTime,
  },
} as const;

const membership = {
  type: "object",
  properties: {
    tenantId: uuid,
    userId: { type: "string" },
    role,
    joinedAt: dateTime,
    updatedAt: dateTime,
  },
} as const;

const errorResponses = { "4xx": problemSchema, "5xx": problemSchema } as const;

const pageQuery = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 100 },
    cursor: { type: "string", minLength: 1, maxLength: 512 },
  },
} as const;

const tenantIdParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export const schemas = {
  createTenant: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["name", "slug"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100 },
        slug: { type: "string", minLength: 3, maxLength: 40, pattern: "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$" },
      },
    },
    response: {
      201: { type: "object", properties: { tenant, adminInvite: invite } },
      ...errorResponses,
    },
  },
  listTenants: {
    querystring: pageQuery,
    response: {
      200: {
        type: "object",
        properties: { items: { type: "array", items: tenant }, nextCursor: { type: ["string", "null"] } },
      },
      ...errorResponses,
    },
  },
  getMe: {
    response: {
      200: {
        type: "object",
        properties: {
          userId: { type: "string" },
          tenantId: { type: ["string", "null"] },
          role: { type: ["string", "null"], enum: ["trader", "tenant-admin", null] },
          tokenTenantId: { type: ["string", "null"] },
          tokenNeedsRefresh: { type: "boolean" },
          identityPending: { type: "boolean" },
        },
      },
      ...errorResponses,
    },
  },
  createInvite: {
    params: tenantIdParams,
    body: {
      type: "object",
      additionalProperties: false,
      properties: {
        role,
        maxUses: { type: "integer", minimum: 1, maximum: 100 },
        expiresInHours: { type: "integer", minimum: 1, maximum: 720 },
      },
    },
    response: { 201: invite, ...errorResponses },
  },
  listMembers: {
    params: tenantIdParams,
    querystring: pageQuery,
    response: {
      200: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { userId: { type: "string" }, role, joinedAt: dateTime },
            },
          },
          nextCursor: { type: ["string", "null"] },
        },
      },
      ...errorResponses,
    },
  },
  changeMemberRole: {
    params: {
      type: "object",
      required: ["id", "userId"],
      properties: { id: { type: "string", format: "uuid" }, userId },
    },
    body: {
      type: "object",
      additionalProperties: false,
      required: ["role"],
      properties: { role },
    },
    response: { 200: membership, ...errorResponses },
  },
  acceptInvite: {
    params: {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string", minLength: 16, maxLength: 128 } },
    },
    response: {
      200: { type: "object", properties: { tenantId: uuid, role } },
      ...errorResponses,
    },
  },
  listMyOrganizations: {
    querystring: pageQuery,
    response: {
      200: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                alias: { type: "string" },
                tenantId: uuid,
                name: { type: "string" },
                slug: { type: "string" },
                role,
                joinedAt: dateTime,
              },
            },
          },
          nextCursor: { type: ["string", "null"] },
          identityPending: { type: "boolean" },
        },
      },
      ...errorResponses,
    },
  },
  shareJoin: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["token"],
      // 32 random bytes in base64url: 43 characters. The value never appears in an error message.
      properties: { token: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" } },
    },
    response: {
      200: {
        type: "object",
        properties: {
          alias: { type: "string" },
          tenantId: uuid,
          name: { type: "string" },
          marketId: uuid,
          role,
          joined: { type: "boolean" },
        },
      },
      ...errorResponses,
    },
  },
  health: {
    response: {
      200: { type: "object", properties: { status: { type: "string" } } },
      ...errorResponses,
    },
  },
} as const;
