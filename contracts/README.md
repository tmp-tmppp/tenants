# Contracts of the tenants service

The contracts are written first and the code follows them. Tests fail when the two differ.

| File | What it says |
|---|---|
| `openapi.yaml` | OpenAPI 3.1: every HTTP endpoint, the bearer JWT scheme, `application/problem+json` errors, cursor pagination |
| `asyncapi.yaml` | AsyncAPI 3.0: the three events the service publishes (TenantCreated, MemberJoined, MemberRoleChanged) |

## For the authors of consuming services

- **Where.** NATS JetStream, stream `TENANTS` (subjects `chance.tenants.>`). One subject per event and
  tenant: `chance.tenants.<Event>.<tenantId>`, for example `chance.tenants.TenantCreated.<tenantId>`.
  Subscribe with a wildcard (`chance.tenants.TenantCreated.*`) or per event type.
- **Format.** CloudEvents 1.0 in structured JSON mode: the message body is the whole event
  (`specversion`, `id`, `source`, `type`, `subject`, `time`, `datacontenttype`, `data`) with the
  extension attributes `tenantid`, `correlationid` and `causationid`.
- **Delivery is at least once.** Deduplicate by the event `id` (a UUIDv7, also sent in the NATS header
  `Nats-Msg-Id`): store it in the same transaction as your change and skip a repeat.
- **Order.** Events are published in the order they were written, per publisher. Do not depend on order
  between different tenants.
- **Tenant.** Take the tenant from `tenantid`, never from the payload alone.
- **Ignore unknown fields.** New fields are added as optional ones. A breaking change gets a new type
  (`...TenantCreated.v2`) and is published next to the old one for a while.
- **Types.** `si.chance.tenants.TenantCreated.v1`, `si.chance.tenants.MemberJoined.v1`,
  `si.chance.tenants.MemberRoleChanged.v1`.
- **No personal data.** Events carry ids. User names and e-mails are never in them.
