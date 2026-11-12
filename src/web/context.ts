import type { FastifyRequest } from "fastify";
import type { AcceptInvite } from "../usecases/accept-invite.js";
import type { ChangeMemberRole } from "../usecases/change-member-role.js";
import type { CreateInvite } from "../usecases/create-invite.js";
import type { CreateTenant } from "../usecases/create-tenant.js";
import type { GetMe } from "../usecases/get-me.js";
import type { ListMembers } from "../usecases/list-members.js";
import type { ListMyOrganizations } from "../usecases/list-my-organizations.js";
import type { ListTenants } from "../usecases/list-tenants.js";
import type { Caller } from "../usecases/ports.js";
import type { ShareJoin } from "../usecases/share-join.js";
import { requireAuth } from "./auth.js";

export interface UseCases {
  createTenant: CreateTenant;
  listTenants: ListTenants;
  getMe: GetMe;
  listMyOrganizations: ListMyOrganizations;
  shareJoin: ShareJoin;
  createInvite: CreateInvite;
  listMembers: ListMembers;
  changeMemberRole: ChangeMemberRole;
  acceptInvite: AcceptInvite;
}

/** Who is calling and which request it is; the use cases put this into the events they write. */
export function callerOf(request: FastifyRequest): Caller {
  return { userId: requireAuth(request).userId, correlationId: request.correlationId, causationId: request.id };
}
