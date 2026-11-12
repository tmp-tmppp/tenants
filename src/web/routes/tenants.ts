import type { FastifyInstance } from "fastify";
import type { Membership } from "../../domain/membership.js";
import type { Role } from "../../domain/role.js";
import type { Tenant } from "../../domain/tenant.js";
import type { IssuedInvite } from "../../usecases/create-tenant.js";
import { platformAdminHook, requireTenantAdmin, tenantAdminHook } from "../auth.js";
import type { RequestHook } from "../auth.js";
import { callerOf } from "../context.js";
import type { UseCases } from "../context.js";
import { schemas } from "../schemas.js";

const emptyBodyAsObject: RequestHook = (request) => {
  request.body ??= {};
  return Promise.resolve();
};

const tenantBody = (tenant: Tenant) => ({
  id: tenant.id,
  name: tenant.name,
  slug: tenant.slug,
  status: tenant.status,
  createdBy: tenant.createdBy,
  createdAt: tenant.createdAt.toISOString(),
});

export const inviteBody = (invite: IssuedInvite) => ({
  code: invite.code,
  role: invite.role,
  maxUses: invite.maxUses,
  expiresAt: invite.expiresAt.toISOString(),
});

const membershipBody = (m: Membership) => ({
  tenantId: m.tenantId,
  userId: m.userId,
  role: m.role,
  joinedAt: m.joinedAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

interface PageQuery {
  limit?: number;
  cursor?: string;
}

// Defaults of the invite endpoint (also written in contracts/openapi.yaml).
const DEFAULT_INVITE_ROLE: Role = "trader";
const DEFAULT_INVITE_USES = 1;
const DEFAULT_INVITE_TTL_HOURS = 168;

/**
 * Routes of the tenant registry. Authentication is an onRequest hook (401 first); the role and tenant checks run
 * in preValidation, before the body is validated, so a caller without rights learns nothing from validation.
 */
export function registerTenantRoutes(
  app: FastifyInstance,
  useCases: UseCases,
  authenticate: RequestHook,
): void {
  app.post<{ Body: { name: string; slug: string } }>(
    "/v1/tenants",
    {
      schema: schemas.createTenant,
      onRequest: authenticate,
      preValidation: platformAdminHook,
    },
    async (request, reply) => {
      const { tenant, adminInvite } = await useCases.createTenant.execute({
        name: request.body.name,
        slug: request.body.slug,
        caller: callerOf(request),
      });
      return reply.code(201).send({ tenant: tenantBody(tenant), adminInvite: inviteBody(adminInvite) });
    },
  );

  app.get<{ Querystring: PageQuery }>(
    "/v1/tenants",
    { schema: schemas.listTenants, onRequest: authenticate, preValidation: platformAdminHook },
    async (request) => {
      const page = await useCases.listTenants.execute({ limit: request.query.limit, cursor: request.query.cursor });
      return { items: page.items.map(tenantBody), nextCursor: page.nextCursor };
    },
  );

  app.post<{ Params: { id: string }; Body?: { role?: Role; maxUses?: number; expiresInHours?: number } }>(
    "/v1/tenants/:id/invites",
    {
      schema: schemas.createInvite,
      onRequest: authenticate,
      // The body is optional (all fields have defaults): an empty POST validates as {}.
      preValidation: [emptyBodyAsObject, tenantAdminHook],
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const invite = await useCases.createInvite.execute({
        tenantId: requireTenantAdmin(request),
        role: body.role ?? DEFAULT_INVITE_ROLE,
        maxUses: body.maxUses ?? DEFAULT_INVITE_USES,
        expiresInHours: body.expiresInHours ?? DEFAULT_INVITE_TTL_HOURS,
        caller: callerOf(request),
      });
      return reply.code(201).send(inviteBody(invite));
    },
  );

  app.get<{ Params: { id: string }; Querystring: PageQuery }>(
    "/v1/tenants/:id/members",
    {
      schema: schemas.listMembers,
      onRequest: authenticate,
      preValidation: tenantAdminHook,
    },
    async (request) => {
      const page = await useCases.listMembers.execute({
        tenantId: requireTenantAdmin(request),
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return {
        items: page.items.map((m) => ({ userId: m.userId, role: m.role, joinedAt: m.joinedAt.toISOString() })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.put<{ Params: { id: string; userId: string }; Body: { role: Role } }>(
    "/v1/tenants/:id/members/:userId/role",
    {
      schema: schemas.changeMemberRole,
      onRequest: authenticate,
      preValidation: tenantAdminHook,
    },
    async (request) => {
      const membership = await useCases.changeMemberRole.execute({
        tenantId: requireTenantAdmin(request),
        userId: request.params.userId,
        role: request.body.role,
        caller: callerOf(request),
      });
      return membershipBody(membership);
    },
  );
}
