# tenants

The tenant registry of **Chance**, where each organization (a *tenant*) runs its own private prediction markets.
This service keeps the organizations, invite codes, memberships and roles, and makes the identity provider match
them, so that every access token carries the user's tenant and role. All the other services read the tenant from
that token and create a tenant's database schema when they receive `TenantCreated`.

## API

Contract: [`contracts/openapi.yaml`](contracts/openapi.yaml) (OpenAPI 3.1). Every endpoint needs a bearer token
from the identity provider; errors are RFC 9457 problem details (`application/problem+json`).

| Method and path | Who | What |
|---|---|---|
| `POST /v1/tenants` | platform admin | Create a tenant; returns a one-time invite code for its first admin |
| `GET /v1/tenants` | platform admin | List tenants (cursor pagination) |
| `GET /v1/me` | any user | My membership in the organization of the token (a token without an organization shows the only membership, if there is exactly one); `tokenNeedsRefresh` tells the web UI to refresh the token after a change, `identityPending` that the identity provider does not hold the change yet (refreshing cannot help before it is `false`) |
| `GET /v1/me/organizations` | any user, with or without an organization in the token | The organizations I belong to (alias, name, my role), oldest membership first, cursor pagination; how the web UI finds the organization to ask the token for (`scope=organization:<alias>`) |
| `POST /v1/share-joins` | any user | Join the organization of a shared market with a share-link token (in the body, never in a URL): markets decides what the link allows, a new membership is `trader`; the answer holds the alias and the market id so the web UI can switch and open the market |
| `POST /v1/tenants/{id}/invites` | tenant admin | Create an invite code (role, number of uses, lifetime) |
| `GET /v1/tenants/{id}/members` | tenant admin | List members (ids and roles) |
| `PUT /v1/tenants/{id}/members/{userId}/role` | tenant admin | Change a member's role; the last tenant admin cannot be demoted |
| `POST /v1/invites/{code}/accept` | any user | Join the tenant of an invite, also as a member of other tenants (one membership per user and tenant, each with its own role); a second accept of the same tenant answers the existing membership |
| `GET /health/startup`, `/health/ready`, `/health/live` | Kubernetes | Probes; readiness checks the database and answers `503` as soon as the process gets SIGTERM, liveness only the process |

The tenant always comes from the token, never from the URL or the body: a tenant admin who asks for another
tenant's id gets `404`. Invite codes are shown once, when created; the database stores only their SHA-256 hash.

Status codes worth knowing:

- `401` means the token is wrong: expired, bad signature, wrong issuer or audience, unknown key id, malformed.
- `503` with `Retry-After: 5` and the code `identity_provider_unavailable` means the token cannot be checked at all
  because the identity provider's signing keys cannot be fetched (timeout, network error, an error status, a key set
  that cannot be read). The token is not necessarily wrong, so a client retries instead of logging the user out. It is
  the answer of every authenticated operation (the shared response `ServiceUnavailable` in the contract). Keys that
  were fetched less than 10 minutes ago are cached, so a short outage of the identity provider is not noticed.
- `400` also for a tenant name with control characters (NUL, tab, line breaks ...; surrounding whitespace is
  trimmed) and for a `cursor` that this service did not issue: the time must be an ISO time from 1970-01-01 to
  9999-12-31, the key a tenant id (tenant list) or a user id of 1 to 255 characters without control characters
  (member list).

## Events

Contract: [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml) (AsyncAPI 3.0); notes for consumers:
[`contracts/README.md`](contracts/README.md).

| Event | When |
|---|---|
| `si.chance.tenants.TenantCreated.v1` | A tenant was created |
| `si.chance.tenants.MemberJoined.v1` | A user accepted an invite |
| `si.chance.tenants.MemberRoleChanged.v1` | A tenant admin changed a member's role |

Events are CloudEvents 1.0 on NATS JetStream (stream `TENANTS`, subjects `chance.tenants.<Event>.<tenantId>`).
They are written to an outbox table in the same transaction as the change and published by a relay inside the
service (transactional outbox), so a change is never stored without its event or published without being stored.

## How a change flows

The database is the source of truth and the identity provider follows it (ADR-054). A request never calls the
identity provider; a background reconciler does.

1. A request is authenticated (JWT signature, issuer, audience) and the caller's role is checked.
2. The use case writes one database transaction: the change, its event in the outbox and an *identity-sync item*
   (`tenant/<tenantId>` or `member/<userId>`) in the table `shared.identity_sync`. Nothing else is called, so the
   answer does not wait for the identity provider and does not fail when it is down. Role changes lock the tenant's
   row first, so changes of one tenant are applied one after the other, each on the row the previous one left.
3. The outbox relay publishes the event rows to NATS and marks them as published. Only one instance publishes at a
   time: the claim takes a PostgreSQL advisory lock for the length of its transaction and returns nothing while another
   instance holds it, so the events of a tenant keep their order with several replicas (a rolling update runs two for
   a while). Published rows are deleted after the max age of the stream (`STREAM_MAX_AGE_DAYS`, 30 days by default), at most once an hour.
4. The identity-sync worker (a loop in the same service, every `IDENTITY_SYNC_POLL_MS`) claims up to 5 due items that
   nobody holds and leases them for 120 seconds (`FOR UPDATE SKIP LOCKED`, so several instances never take the same
   one) and reads the *current* rows: for a tenant item it makes sure the organization exists and holds its two groups
   `tenant-admin` and `trader`; for a member item (one per user) it goes through all memberships of the user and makes
   sure the user is a member of each organization and in exactly one of its two groups, the one of the role of the row
   (a role change moves the user from one group to the other). Roles are organization groups, never realm roles or role
   mappings (Keycloak copies the roles of an organization group into the realm roles of every organization). All calls are idempotent, so repeating an item is safe. They are protected by a timeout, retries
   with backoff and a circuit breaker. The lease is a column of its own (`lease_until`): a new change for a key that is
   being processed does not release it, so two instances never reconcile the same key at the same time (that could
   leave the wrong role in the identity provider). The worker stops starting the items of a batch once the lease has
   passed; they are claimed again.
5. A finished item is deleted only if no newer change for the same key arrived meanwhile: every enqueue takes a new
   version from one database sequence shared by all keys, so a version is never issued twice, not even after the row
   was deleted and the key was queued again (a worker whose lease ran out cannot delete a newer row with a late
   completion). When a newer change did arrive, the row stays, its lease is released and the next poll processes the
   newer version. A failed item stays and is tried again: after 1 s, 2 s, 4 s ... up to 5 minutes when the identity
   provider is unavailable (network error, timeout, open circuit, 429, 5xx; logged as a warning), and every 5
   minutes when it answered and refused (400, 401, 403, an unexpected 404; logged as an error with the status, for
   example a service account without the permission to manage organizations). A sync that is rejected for good is
   therefore retried every 5 minutes and logged as an error each time, until someone fixes the cause.

The identity provider therefore follows the database a moment later, for joins and for role changes alike. A user who
has just joined a tenant gets the tenant and role in the token only after the item was processed and the token was
refreshed. A *demotion* works the same way: it reaches Keycloak shortly after the request, but the user's current
access token keeps the old role until it is refreshed (access tokens live 5 minutes), so a demoted tenant admin can
still act as one for up to that long. `GET /v1/me` says which of the two is missing: `identityPending` is `true` while
the user's item is queued, and `tokenNeedsRefresh` is `true` while the token differs from the database.

## Configuration

Settings come from environment variables; the service refuses to start with a clear message when a required one
is missing or invalid. In Kubernetes the non-secret ones come from the chart's ConfigMap and the secret ones from
the Secret `tenants-env`.

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `APP_ENV` | `production` | no | `local` allows in-memory replacements for the database, NATS and the identity provider |
| `PORT` | `8080` | no | HTTP port |
| `METRICS_PORT` | `9464` | no | Port of the separate listener that serves `GET /metrics` (1 to 65535); must differ from `PORT` (see "Metrics") |
| `LOG_LEVEL` | `info` | no | `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `DATABASE_URL` | required | **yes** | PostgreSQL connection string of the service's own database |
| `DATABASE_POOL_MAX` | `5` | no | Maximum database connections |
| `NATS_URL` | required | no | NATS server |
| `KEYCLOAK_URL` | required | no | Keycloak base URL (admin API; in the cluster `http://identity:8080`) |
| `KEYCLOAK_REALM` | required with `KEYCLOAK_URL` | no | Realm name |
| `KEYCLOAK_CLIENT_ID` | required with `KEYCLOAK_URL` | no | Service-account client of this service |
| `KEYCLOAK_CLIENT_SECRET` | required with `KEYCLOAK_URL` | **yes** | Its client secret |
| `MARKETS_ADMISSION_CLIENT_ID` | required with `KEYCLOAK_URL` and `MARKETS_BASE_URL` | no | The client for the calls to markets (`tenants-markets` in the realm: audience `chance`, no Admin API role); must differ from `KEYCLOAK_CLIENT_ID` |
| `MARKETS_ADMISSION_CLIENT_SECRET` | required with `MARKETS_ADMISSION_CLIENT_ID` | **yes** | Its client secret (`TENANTS_MARKETS_CLIENT_SECRET` of the identity service) |
| `MARKETS_BASE_URL` | required (optional when `APP_ENV=local`) | no | Base URL of markets (in the cluster `http://markets:8080`); share joins ask its internal admission endpoint with the client-credentials token of `MARKETS_ADMISSION_CLIENT_ID` (never the admin client: its token is sent to no service). Unset in local mode, every share join answers `503` |
| `AUTH_JWKS_URL` | required | no | Where the token signing keys are published |
| `AUTH_ISSUER` | required | no | Expected `iss` of the tokens |
| `AUTH_AUDIENCE` | required | no | Expected `aud` of the tokens |
| `AUTH_ROLES_CLAIM` | `realm_access.roles` | no | Claim path of the realm roles; read for `platform-admin` only (a `trader` or `tenant-admin` realm role is ignored) |
| `AUTH_TENANT_CLAIM` | `organization` | no | Claim of the tenant (the Keycloak organization alias is the tenant id). The token holds exactly one organization; its group `/tenant-admin` or `/trader` in `organization.<alias>.groups` is the tenant role (token contract v2) |
| `INVITE_ADMIN_TTL_HOURS` | `168` | no | Lifetime of the first admin's invite |
| `OUTBOX_POLL_MS` | `300` | no | How often the relay looks for unpublished events |
| `STREAM_MAX_AGE_DAYS` | `30` | no | Max age of the TENANTS stream (1 to 365 days) and how long the outbox keeps a published row; the same in every service, so a service started later still reads older events |
| `IDENTITY_SYNC_POLL_MS` | `500` | no | How often the identity-sync worker looks for queued items (50 to 60000) |
| `SHUTDOWN_DELAY_MS` | `5000` (`0` when `APP_ENV=local`) | no | Drain delay after SIGTERM, 0 to 15000: readiness answers `503` at once, the service keeps serving for this long, then it closes (see "Shutdown") |

## Metrics

Rate, errors and duration of the HTTP API (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module is
[`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), a listener of its own: any other path there answers
  `404`, and the API port (`PORT`) never serves `/metrics`, so the gateway can never route it. The listener starts with
  the service and closes with it on shutdown (after the API server). The default is the same in every service, so
  services started natively on one host need a different `METRICS_PORT` each (in a cluster every Pod has its own
  address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`. Errors are the `status_code` values 4xx and 5xx; the
  duration runs from the arrival of the request to the end of its response.
- **`route`** is the route template (`/v1/tenants/:id/members`), or `unmatched` for a request that matched no route
  (a 404), so a raw URL or an id never becomes a label value.
- **`tenant`** is the tenant id in the token the service verified, `none` when the request has no verified token or the
  token names no tenant. It is never read from a header or the body.
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port.

## Shutdown

On SIGTERM (Kubernetes) or SIGINT the service shuts down in two steps, so that a rolling deploy does not fail
requests that were already on their way:

1. **Drain.** `GET /health/ready` answers `503` (code `shutting_down`) from this moment. The service keeps serving
   requests and keeps its loops running for `SHUTDOWN_DELAY_MS` (default 5 seconds), the time the load balancer needs
   to take the pod out of rotation.
2. **Close.** It stops accepting connections and finishes the requests in flight, closes the metrics listener, stops
   the relay and the identity-sync worker (each finishes the item it is on), closes NATS and the database pool, and
   exits with `0`. If closing takes more than 10 seconds after the delay, it exits with `1`.

The chart keeps `terminationGracePeriodSeconds: 30`: the delay is limited to 15 seconds, so delay plus close always
ends before Kubernetes sends SIGKILL. The same limit protects a longer `SHUTDOWN_DELAY_MS` from being cut off.

## Run locally

Node.js 24 is required.

```bash
npm ci
npm run build
APP_ENV=local npm start          # everything in memory, events only logged, a fake identity provider
```

With a real database and NATS (Docker needed): `docker compose up -d`, then start with `DATABASE_URL` and
`NATS_URL` as shown at the top of [`compose.yaml`](compose.yaml). Tokens are always verified, also locally.

## Tests

```bash
npm run lint                     # ESLint, including the layer rules below
npm run typecheck
npm test                         # unit, web and contract tests; npm test -- --coverage for the coverage report
npm run test:integration         # PostgreSQL in a container (Testcontainers); needs Docker
```

The Keycloak adapter also has a test against a real Keycloak with the realm of the `identity` repository. It runs
within `npm run test:integration` only when the server is up (in `identity/`: `docker compose up -d --build`) and
these variables are set: `KEYCLOAK_TEST_URL` (for example `http://localhost:8081`), `KEYCLOAK_TEST_CLIENT_SECRET`
(the `tenants` client's secret), `KEYCLOAK_TEST_ADMIN_USERNAME` and `KEYCLOAK_TEST_ADMIN_PASSWORD` (the bootstrap
admin, to create a test user); see `identity/compose.yaml` for the local values.

The contract tests fail when a route is missing from `contracts/openapi.yaml` (or the other way round), when a
response does not match its documented schema, or when an event does not match `contracts/asyncapi.yaml`.

## Layout (Clean Architecture)

| Folder | Holds | May import |
|---|---|---|
| `src/domain` | Entities, rules and event builders, no I/O | nothing outside the domain |
| `src/usecases` | One class per use case, the ports (interfaces) | the domain |
| `src/adapters` | PostgreSQL, Keycloak, NATS, the outbox relay, the identity-sync worker, the metrics module, in-memory versions for tests | use cases and domain |
| `src/web` | Fastify routes, token checks, problem details | use cases and domain |
| `src/main.ts` | Composition root: configuration, adapters, use cases, server | everything |
| `src/shutdown.ts` | The shutdown sequence (drain, delay, close in order, hard-exit timer); its steps are passed in, so it is tested with fake timers | the logger port |
| `migrations` | Versioned SQL, applied at startup under an advisory lock | |
| `helm` | Chart with dev and prod values and a `helm test` smoke test | |

The lint fails when an inner layer imports an outer one.

## Delivery

Pull requests run lint, type check, tests with coverage, chart checks and an image build; a merge to `main` builds
the image once, pushes it to Docker Hub and deploys it to the prod namespace with Helm, followed by the smoke test
and an automatic rollback on failure. The steps live in the organization's shared workflow; see
[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml).

`AUTH_ISSUER` in `helm/values-prod.yaml` is empty on purpose: its value, `https://<public host>/realms/chance`, comes
from the pipeline's public host (plan INF-01). A deploy without it stops at start with "AUTH_ISSUER is required" (the
Pod restarts and the deploy rolls back) instead of answering every token with 401.

## Implementation notes for the next services

Traps found while building this template; each is handled in the code named here.

- **Fastify's default Ajv coerces types** (`coerceTypes: "array"`): a service that takes amounts sets `coerceTypes: false`, as the payment provider does.
- **pg returns `bigint` and count results as strings**: convert with `Number(...)` (identity_sync versions, the admin count).
- **The in-memory store swaps in the transaction's draft at commit**: every method that changes state outside a transaction (the queue's claim, complete and fail) must run on the same promise queue as the transactions, or its write is lost (`src/adapters/memory/memory-store.ts`).
- **`INSERT ... VALUES (nextval(seq)) ON CONFLICT DO UPDATE SET version = nextval(seq)` uses a number even when the row exists**: versions have gaps, so tests compare them relatively; the `SET` needs its own `nextval`, not `EXCLUDED.version` (migration 003).
- **jose's remote key set throws** the plain `JOSEError` for a non-200 or non-JSON answer, `JWKSTimeout`, `JWKSInvalid` and a bare `TypeError` for network failures (all mean 503), while `JWKSNoMatchingKey` is a token problem (401); only the key resolver is wrapped (`src/web/auth.ts`).
- **cockatiel's open circuit (`BrokenCircuitError`)** is its own error class: classify it explicitly as "unavailable".
- **`new Date("2026-02-30T00:00:00.000Z")` is valid in V8 (March 2)**: accept a time only when `toISOString()` returns the same text (`src/usecases/support.ts`).
- **Fastify answers a path parameter longer than `maxParamLength` (default 100) with a plain 414** before the route schema and the problem handler run: set `routerOptions.maxParamLength` above the schema limit (`src/web/app.ts`).
- **`String.prototype.isWellFormed` is not in TypeScript's `ES2023` lib**: `/\p{Cs}/u` finds lone surrogates.
- **`SELECT ... FOR UPDATE` on a parent row also blocks child inserts** (their foreign-key share lock) while it is held; `FOR NO KEY UPDATE` would not, if that ever matters.
- **A lease must live in its own column** (`lease_until`), never in the due time that a new change resets (migration 004).
