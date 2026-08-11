# Architecture

> Scope and phase status live in [PLAN.md](PLAN.md). This document explains the shape of
> the system and why each layer exists.

## Shape

A **modular monolith**: one deployable process with deliberate internal boundaries.

```text
Client
  │
  ▼
┌─────────────────────────────────────────────┐
│ Fastify HTTP API                            │
│   request context  (requestId / traceId)    │  ← Phase 1
│   error handler    (OpenAI error envelope)  │  ← Phase 1
│   authentication   (API key)                │  ← Phase 7.5 ✅
│   rate limiting    (Redis token bucket)     │  ← Phase 8 ✅
│   validation       (Zod)                    │  ← Phase 4
└─────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────┐
│ Router                                      │
│   model resolution: explicit → alias → route│  ← Phase 6
│   retry    (same provider,  retryable)      │  ← Phase 7
│   fallback (other provider, failoverable)   │  ← Phase 6
│   timeouts (per call + per request)         │  ← Phase 7
└─────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────┐
│ LLMProvider abstraction                     │  ← Phase 2
│   OpenAI · Gemini · Anthropic · Ollama · Mock│ ← Phase 3
└─────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────┐
│ Observability                               │
│   Redis      rate limits, cache, health     │  ← Phase 8 ✅
│   PostgreSQL api_keys, requests             │  ← Phase 9 ✅
└─────────────────────────────────────────────┘
```

### Why a monolith

Every piece above shares the same request lifecycle and the same latency budget. Splitting
routing from providers across a network boundary would add a hop, a serialization step, and
a new failure mode to a path whose entire job is to be a thin, reliable proxy.

The boundaries exist so extraction is *possible* later — not because it is planned. That is
the only justification for a boundary at this stage.

---

## Layers

### Configuration (`src/config`)

The only place `process.env` is read — enforced by an ESLint rule, not convention. A Zod
schema parses the environment once at boot and produces a typed `AppConfig` that everything
downstream receives by injection.

*Problem it solves:* a container that starts with a malformed `DATABASE_URL` and only
discovers it on the first request has already been marked healthy and put into rotation.
Failing at boot keeps the broken deploy out.

*Alternative:* read `process.env` where needed. Rejected — it makes configuration untestable
and leaves no single place to see what the service actually requires.

### Logging (`src/observability/logger.ts`)

Pino, which Fastify already uses, so this costs no new dependency. Redaction paths for
`Authorization`, `x-api-key`, cookies, and token-shaped fields are configured in the base
logger.

*Why redaction lives in config:* the alternative is trusting every future contributor to
remember not to log a header. One is a property of the system; the other is a hope.

### Infrastructure clients (`src/infra`)

Postgres (`pg` pool + Drizzle) and Redis (ioredis) both implement the same
`DependencyCheck` / `Closable` shape:

```ts
interface DependencyCheck {
  readonly name: string;
  ping(timeoutMs: number): Promise<void>;
}
```

The readiness probe and the shutdown sequence both iterate over this interface. Adding a
new backing service means implementing it — not editing the probe *and* the shutdown path.

Two decisions worth knowing:

- **The Postgres pool is bounded.** An unbounded pool does not fail fast under load; it
  opens connections until Postgres itself refuses them, converting a traffic spike into a
  database-wide outage affecting every other client of that database.
- **Redis runs with `enableOfflineQueue: false`.** ioredis defaults to buffering commands
  while disconnected and replaying them on reconnect. For a gateway that is wrong twice
  over: the readiness probe would hang instead of reporting Redis down, and (from Phase 8)
  rate-limit increments would be replayed against a window that has already closed.

Neither client connects at construction. A datastore outage at boot therefore does not stop
the gateway from starting and correctly reporting itself not-ready — which is far more
observable than a crash loop.

### HTTP (`src/http`)

`buildServer(deps)` is a pure function of its dependencies: it opens no connections and
listens on no port.

*Why this matters:* the unit tests run the real server with fake dependencies via
`app.inject()`, and the integration tests run the **same builder** against real Redis and
Postgres. A server that constructs its own database pool can only ever be tested against a
database.

#### Request context

An `onRequest` hook assigns a `requestId` and a `traceId` and stores them in
`AsyncLocalStorage`.

*Problem it solves:* threading a context parameter through every function between the route
and the provider HTTP client. From Phase 3, a provider adapter can log with the correct
request ID without the router handing it one.

*Why in Phase 1 rather than Phase 9:* retrofitting correlation IDs through an
already-written router, retry, and fallback stack means touching every file a second time.
It costs about forty lines now.

This is also the seam OpenTelemetry slots into — an OTel span context lives in exactly this
kind of storage — which is why OTel is not a dependency yet.

#### Error handling

One `setErrorHandler` maps everything to the OpenAI-compatible envelope:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": "INVALID_REQUEST", "request_id": "req_..." } }
```

Phase 4 adds `/v1/chat/completions` without a second error path. That is what keeps the
compatibility promise honest: a client's error handling behaves the same whether the failure
came from our validation layer, our router, or the upstream provider.

Unknown errors log in full server-side and return a generic message plus the request ID.
Stack traces are never a response body.

### Error model (`packages/core/src/errors.ts`)

Providers translate their native failures into one normalized taxonomy. Each code carries an
HTTP status, an OpenAI error type, and **two independent recovery flags**:

- `retryable` — is retrying the **same** provider worthwhile?
- `failoverable` — is trying a **different** provider worthwhile?

| Code | Status | Retry same | Try next | Reasoning |
|---|---|---|---|---|
| `INVALID_REQUEST` | 400 | no | no | Fails identically everywhere |
| `INTERNAL_ERROR` | 500 | no | no | Our bug — same result anywhere |
| `AUTHENTICATION_ERROR` | 401 | no | **yes** | Our key won't fix itself; another provider has its own |
| `MODEL_NOT_FOUND` | 404 | no | **yes** | Same provider still lacks it; another may have an equivalent |
| `TIMEOUT` | 504 | no | **yes** | Hammering a slow provider rarely helps |
| `RATE_LIMITED` | 429 | **yes** | **yes** | Transient; others likely have capacity |
| `PROVIDER_ERROR` | 502 | **yes** | **yes** | Provider-side 5xx, often transient |
| `UNAVAILABLE` | 503 | **yes** | **yes** | DNS failure, connection refused, circuit open |

*Why two flags rather than one:* collapsing them forces a choice between failing requests a
configured fallback could have served (`MODEL_NOT_FOUND` treated as fatal) and burning attempts
on errors that cannot improve (`INVALID_REQUEST` replayed at four providers for four identical
400s). Spec §8 requires the distinction to be explicit, and these flags are where it lives.

Both decisions are read from the normalized code, never by parsing a provider's error text.

### Provider abstraction (`src/providers`)

```ts
interface LLMProvider {
  readonly id: ProviderId;
  chat(request: ChatRequest, options: ProviderCallOptions): Promise<ChatResponse>;
  stream(request: ChatRequest, options: ProviderCallOptions): AsyncIterable<ChatChunk>;
  getCapabilities(): ProviderCapabilities;
}
```

Nothing above this interface knows that OpenAI, Gemini, Anthropic or Ollama exist. Adding a
fifth provider changes no routing, retry, or observability code.

Requests are **normalized on the way in and denormalized on the way out**:

```text
OpenAI-shaped body → ChatRequest → provider-native
provider-native    → ChatResponse → OpenAI-shaped body
```

*Why not pass the OpenAI body straight through:* Gemini uses `contents`/`parts` and Anthropic
hoists the system prompt to a top-level field, so every adapter would end up re-parsing the
same body and re-deriving the same facts. The router also needs to reason about a request —
which model, how many tokens — without knowing whose format it is in.

Three details that carry weight:

- **Cancellation is an `AbortSignal`, and it is required.** Racing a timer against a promise
  only abandons it; the HTTP request keeps running, the socket stays open, and the tokens are
  still generated and billed. A signal actually cancels — and the same mechanism carries
  client disconnect upstream in Phase 5.
- **`ChatChunk` is a discriminated union**: `start` → `delta`* → `finish`. The `start` chunk
  reports which model actually served the request, which under fallback is not something the
  caller can predict. The SSE layer becomes an exhaustive switch that fails the build when a
  variant is added and left unhandled.
- **Unknown token usage is `undefined`, never zero.** Providers omit usage on streamed
  responses and return nulls on errors. Zero-filling would give Phase 9 a confident number
  that understates the bill; `ProviderCapabilities.usageReporting` says up front whether a
  real figure is even obtainable.

Normalization that every adapter needs lives in `messages.ts` and `usage.ts` rather than being
re-derived — subtly differently — four times.

### Dashboard (`apps/dashboard`)

```text
browser ──► nginx ──┬──► static SPA
                    └──► /v1/* proxied to the gateway
```

**Same-origin by construction.** nginx proxies `/v1` rather than letting the browser call the
gateway directly, and the Vite dev server does the same. That is why no CORS configuration
exists anywhere in the project, and why the gateway never needs to know the dashboard's address.

**A separate, read-only credential.** The dashboard holds `DASHBOARD_API_KEY`, which the
authentication hook accepts only on `/v1/admin/stats/*`, `/v1/admin/requests*` and
`/v1/admin/traces/*`. Key creation and revocation still require `ADMIN_API_KEY`. A browser
app's credential is one XSS away from being someone else's, so it must not be one that can mint
API keys.

**No business logic in components** (spec §22). All fetching, URL building and response shaping
lives in `src/api/`; components receive data and render it. Formatting rules — most importantly
"null renders as —, never as 0" — live in `format.ts` so they are stated once and testable.

**Dense tables, and exactly one chart.** Spec §18 asks for useful infrastructure information
over polish. "Is it working", "what is it costing" and "what happened to that request" are all
answered better by a number than by a graph, so they are numbers.

The one graph earns its place by answering the question a number cannot: **is it getting
worse?** A 96% success rate reads identically whether the failures are spread evenly across the
window or all arrived in the last four minutes, and those are opposite situations. It is a
stacked column of successes and errors per time bucket, served by `/v1/admin/stats/timeseries`.

Two details in it are deliberate. The gateway returns a gap-filled bucket spine, so an idle
period renders as a run of zeros rather than vanishing — a chart that silently omits empty
buckets draws an outage as a narrower, healthier-looking chart. And errors are drawn on the
baseline rather than stacked on top, because only the baseline-anchored segment of a stack can
be compared across columns by eye.

The colors are not the obvious green/red pair. Measured under deuteranopia simulation, that
pair separates by ΔE 4.1 — for a red-green colorblind reader the two halves of every bar are
the same color. The blue actually used measures 25.7 against the same red. Identity never rests
on hue alone regardless: there is a legend, a labelled tooltip, and a data table under every
chart.

Geometry lives in `chart-geometry.ts` as pure functions, so the failures that are invisible in
a screenshot taken on a good day — a bar overflowing its plot only when errors spike, a single
error rounded away to nothing — are unit-tested rather than eyeballed. There is no charting
library: one stacked column chart is about 200 lines, and a dependency shipping a canvas
renderer, a locale bundle and its own theming system to draw it is not a trade worth making.

### Request recording (`src/observability`)

```text
request  →  ObservationDraft (per request, mutable)
              ↓ onResponse hook, or explicitly for hijacked streams
            RequestRecorder  →  buffer  →  batched INSERT
```

**Off the request path, always.** An awaited INSERT per request adds a database round-trip to
every call and puts Postgres in the critical path of an API whose whole job is proxying
somebody else's — so a slow Postgres makes the gateway slow, and a down Postgres makes it down,
to save data nobody is reading right now. Records are buffered and written in batches; a write
failure loses metrics, which is the correct thing to lose.

**The buffer is bounded.** Unbounded, a Postgres outage grows it until the process OOMs —
turning a recoverable dependency failure into a hard crash that also loses everything already
buffered. Instead the oldest records are dropped and counted.

**Recording lives in `onResponse`, not the route**, so it covers success, validation failure,
rate limit and provider error uniformly. Streaming is the exception: `reply.hijack()` means
`onResponse` never fires, so that path records itself and a `recorded` flag keeps it idempotent.

**The draft is decorated as undefined and assigned per request.** Decorating with an object
literal would give every concurrent request the *same* draft, since Fastify shares the value —
one request's provider would overwrite another's.

**No prompt column, no completion column.** Not unpopulated — absent. The observation type has
no field for content, so no call site can supply any, and an integration test asserts the table
has no content-shaped column.

**Cost is an estimate and says so.** Pricing is data in `openllm.yaml`, not constants in the
calculation, because prices change and a correction should not need a redeploy. Unknown pricing
yields NULL rather than zero — the same honesty rule as token usage — and the column is
`NUMERIC`, because a request costs a fraction of a cent and float error accumulates exactly
where the number matters most.

### Redis features (`src/redis`)

```text
openllm:v1:rl:key:3f2a…      token bucket
openllm:v1:cache:9c81…       cached response
openllm:v1:health:openai     consecutive failure count
```

The **version segment** exists because a rolling deploy runs two code versions at once; without
it, new code reads old values in a changed format and misbehaves silently for the rollout.

**Rate limiting is a token bucket in Lua.** Read-modify-write across a network is a race — two
concurrent requests both read "1 token left" and both proceed. The whole decision therefore runs
inside Redis as one atomic script. A bucket rather than a fixed window because §12 wants
tokens/minute later, and a bucket makes that a change of *cost*, not a rewrite; a fixed window
also permits a double burst across its boundary. The script reads `redis.call('TIME')` rather
than a gateway timestamp, because replicas with skewed clocks would refill inconsistently.

**Everything here fails safe, in the direction that keeps traffic flowing:**

| Feature | Redis unavailable |
|---|---|
| Rate limiter | allows (configurable), flags `degraded` |
| Response cache | treated as a miss |
| Circuit breaker | treated as closed |

That direction is deliberate. These are cost and latency optimisations; none of them is worth
being the reason the gateway is down. The rate limiter's degraded state is surfaced in a header
*and* a warning, because silently not limiting is how an unexpected bill arrives.

**The circuit breaker never opens every path.** If all targets look unhealthy the router tries
anyway — a guaranteed failure is worse than a probably-failing attempt, and it is the only way
the circuit gets a chance to close. Only failoverable errors count against a provider, so one
malformed client request cannot open circuits everywhere.

**The cache stores completions at rest**, which is why it is opt-in. Keys are hashes so prompts
are not recoverable from them; values are not.

### Authentication (`src/auth`, `src/http/plugins/authentication.ts`)

Two separate credentials, deliberately:

| Credential | Lives in | Reaches |
|---|---|---|
| User key `olgm_live_…` | Postgres, **as a SHA-256 hash** | `/v1/*` |
| Admin secret | Environment only | `/v1/admin/*` |

Keeping the admin secret out of the database means a database compromise yields hashes an
attacker cannot reverse *and* no way to issue working credentials.

**SHA-256, not bcrypt.** This looks wrong until you notice two things: these keys are 256 bits
of CSPRNG output, so there is no dictionary to defend against and slowness buys nothing; and
authentication must *look the key up*, which a per-record-salted hash cannot support without
scanning every row. At ~100ms per bcrypt verify that is a throughput cap, not a detail.

**No cache.** One indexed lookup is ~1ms against provider calls measured in hundreds, and the
absence of a TTL is what makes revocation immediate. Measured before adding a cache, not after.

**Probes are always public.** `/health` and `/ready` skip the hook entirely — an orchestrator
has no key, and auth on liveness turns a bad secret into every pod being killed.

**Auth is registered before the routes**, so it applies to every one of them including any
added later. Opting *out* is the explicit act; a route that forgot to opt in would be an open
door.

Unknown and revoked keys produce the identical 401 message — distinguishing them would confirm
to an attacker that a value was once valid. The distinction is in the logs.

### Routing (`src/routing`)

```text
requested model
   │
   ├─ is it a route/alias?  ──yes──►  its ordered target list
   │                                   [gemini-2.5-flash, gpt-4.1-mini]
   └─ no ──► explicit resolution  ──►  single target
                                        openai/gpt-4 → {openai, "gpt-4"}
   │
   ▼
fallback executor: try each target until one succeeds
```

**Two axes, not one.** `retryable` answers "retry the same provider?"; `failoverable`
answers "try a different one?". They genuinely differ: retrying OpenAI for a model it does not
have is pointless, but Anthropic may have an equivalent — `MODEL_NOT_FOUND` is not retryable
yet is failoverable. Same for `AUTHENTICATION_ERROR`. Collapsing them forces a choice between
failing requests a fallback could have served and burning attempts on errors that cannot
improve.

**Targets resolve at boot.** A model that cannot be routed to any provider stops startup. A
fallback route exists for when things are already going wrong; discovering it was
misconfigured *during* an incident is the worst timing. The limit is honest: this checks a
provider can be determined, not that the model exists — verifying that would make startup
depend on every provider being reachable.

**Aliases and routes are one mechanism.** `models:` and `routes:` are two spellings of "a name
mapped to an ordered list". Keeping them separate would raise "which wins when a name is in
both?" with no good answer, so a duplicate name is rejected instead. So is a route name that
would shadow a real model.

**Structure in YAML, credentials in env.** Config files get committed. The file schema is
strict, so an `apiKey` field is a validation error rather than a silently ignored one, and
`enabled` can only turn OFF what the environment already made possible.

**Streaming fallback is a consequence of the streaming design.** Because the route pulls one
chunk before committing to a 200, a failed first provider can still be swapped. After a chunk
is delivered, fallback stops — those tokens are on the wire.

### Reliability (`src/routing/retry.ts`, `deadline.ts`)

```text
for each target:        fallback — a DIFFERENT provider   (failoverable)
  for each attempt:     retry    — the SAME provider      (retryable)
    one provider call   PROVIDER_TIMEOUT_MS
  ...all bounded by     REQUEST_TIMEOUT_MS
```

**Two timeouts.** One bounds a call, the other bounds the operation. Conflating them makes
reliability features multiply latency: nine calls plus eight backoff waits is several minutes
for a caller who left after ten seconds. The request budget is what makes retry and fallback
safe to enable by default.

**The per-attempt signal is rebuilt every attempt** — a single shared `AbortSignal.timeout`
would be spent by the first try and abort every retry after it — and is capped at whatever
remains of the overall budget.

**Retries are exhausted on a target before moving on.** A single-target route still recovers
from a blip; a multi-target route does not skip past a provider that was one retry from
succeeding. `MODEL_NOT_FOUND` shows both axes at once: no retry, immediate failover.

**Jitter is on by default.** Equal jitter keeps 250/500/1000 as the expected value while
breaking client synchronisation. A gateway fronts many callers, so unjittered backoff would
amplify a thundering herd rather than absorb it.

**`Retry-After` beats our guess**, and retries stop early when the remaining budget cannot fit
the wait plus another call — sleeping only to then abandon the request helps nobody.

### Streaming (`src/http/sse.ts`, `disconnect.ts`, `active-streams.ts`)

```text
provider AsyncIterable<ChatChunk>          SSE over the wire
  start  ──────────────────────────►  data: {...delta:{role:"assistant"}}
  delta  ──────────────────────────►  data: {...delta:{content:"Hel"}}
  delta  ──────────────────────────►  data: {...delta:{content:"lo"}}
  finish ──────────────────────────►  data: {...finish_reason:"stop"}
                                      data: {...usage:{...}}   (only if requested)
                                      data: [DONE]
```

**The first chunk is pulled before the status is committed.** Once a byte of body is written
the status code is fixed, so a provider 429 arriving after that could only be reported inside
a nominally successful `200`. Every adapter performs its HTTP request and throws on a non-OK
status *before* yielding, so awaiting exactly one chunk converts rate limits, auth failures,
unknown models and timeouts back into ordinary status codes. Anything failing later becomes an
SSE error event, and the stream closes **without `[DONE]`** — that terminator means success.

**`reply.hijack()`, not a Fastify stream reply.** Fastify's reply lifecycle assumes a single
buffered payload. Hijacking costs us `reply.header()` and `onResponse` hooks, so correlation
headers go into `writeHead` and the route logs its own completion line.

**Backpressure is respected.** A `res.write()` returning false means the client reads slower
than the provider generates; ignoring it turns one slow reader into unbounded heap growth.

**Disconnect detection watches the response, not the request.** `IncomingMessage` emits
`close` once the request *body* has been read — not when the client leaves. Watching it aborts
healthy streams. The response's `close` plus `writableFinished` is what actually distinguishes
"finished writing" from "socket went away". See §7c.3 in [PLAN.md](PLAN.md) — this bug was
invisible to in-process tests and only appeared over a real socket.

**Streams are drained before the server closes.** `ActiveStreams` tracks in-flight responses;
shutdown gives them `SHUTDOWN_STREAM_GRACE_MS` and then aborts cleanly. Registered *ahead* of
the HTTP-server hook, since `app.close()` would otherwise block on a long completion.

### Health and readiness (`src/http/routes/health.ts`)

Covered in the [README](../README.md#why-liveness-and-readiness-are-separate). Two
implementation details worth noting:

- **Checks run in parallel under a hard timeout**, applied by the probe itself rather than
  trusted to each dependency. A health endpoint that hangs is worse than one that reports
  failure — load balancers treat a timeout and a 503 very differently.
- **Results are cached for ~1s.** A load balancer polling at 10rps across N instances
  otherwise generates constant background `SELECT 1` and `PING` load against production
  infrastructure, to answer a question whose answer changes on the order of seconds.

### Lifecycle (`src/infra/shutdown.ts`)

`ShutdownManager` owns the process lifecycle state (`starting → ready → draining → closed`)
and an ordered list of teardown hooks. Both `/health` and `/ready` read that state, which is
what makes readiness fail *before* the server closes.

Hook registration order **is** teardown order: stop accepting work, then close the things
in-flight work depends on.

---

## Repository layout

```text
apps/gateway/src/
  config/          env schema, AppConfig
  observability/   logger
  infra/           postgres, redis, shutdown, shared dependency contract
  http/            server builder, plugins, routes
  db/              Drizzle schema (empty until Phase 8/9)

packages/core/src/
  errors.ts        normalized error model
  ids.ts           correlation ID types and generation
```

`packages/core` holds only what the gateway **and** the dashboard will both import. A
package earns its existence by having at least two consumers; until then, routing,
providers, and observability stay as directories inside `apps/gateway/src` where they are
cheaper to move around. See decision D1 in [PLAN.md](PLAN.md).
