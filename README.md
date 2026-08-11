# OpenLLM Gateway

A self-hosted, open-source **LLM gateway** that speaks the OpenAI API and routes requests
across multiple providers — with retries, fallback, rate limiting, cost tracking, and
request-level observability.

Point your existing OpenAI-compatible SDK at this gateway by changing one line:

```diff
  const client = new OpenAI({
-   baseURL: "https://api.openai.com/v1",
+   baseURL: "http://localhost:4000/v1",
  });
```

> **Status: all 11 phases complete.** `POST /v1/chat/completions` works end to end against
> OpenAI, Anthropic, Gemini, Ollama and a built-in mock provider — buffered or streamed
> over SSE, with model aliases, provider fallback, retry with exponential backoff, two
> independent timeouts, API-key authentication, Redis rate limiting, an optional response
> cache, a provider circuit breaker, per-request persistence with cost estimation, and an
> operator dashboard.
> See [docs/PLAN.md](docs/PLAN.md) for the full roadmap and where things stand.

---

## Why

Running LLMs in production means dealing with rate limits, provider outages, model
deprecations, cost surprises, and having no idea which request cost what. Most teams
solve this by scattering retry logic and provider SDK calls through their application.

This gateway puts that in one place: a single OpenAI-compatible endpoint that handles
routing, failover, and accounting, so applications stay simple and provider decisions
become configuration.

## Design principles

- **Boring, reliable infrastructure** over clever abstractions.
- **No orchestration framework** in the core — provider calls are HTTP requests behind
  our own interface, not a LangChain dependency.
- **Modular monolith.** One deployable process. Clean seams, no premature microservices.
- **Privacy first.** Prompts and completions are never persisted by default.
- **Every failure is normalized** into one internal error model, so routing decisions
  never depend on parsing a provider's error strings.

---

## Quickstart

Requires Docker and Docker Compose.

```bash
git clone <this-repo> && cd openllm-gateway
cp .env.example .env
docker compose up
```

That starts Postgres, Redis, the gateway, and the dashboard on
<http://localhost:3000>. Verify the gateway:

```bash
curl localhost:4000/health   # liveness  — is the process healthy?
curl localhost:4000/ready    # readiness — are Postgres and Redis reachable?
```

Send a completion. The mock provider is enabled in the compose file, so this works
before you configure any API keys:

```bash
curl localhost:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mock","messages":[{"role":"user","content":"Explain Redis Pub/Sub"}]}'
```

With a real key in `.env` (`OPENAI_API_KEY=...`), the same request works against a real
model — `"model": "gpt-4.1-mini"` routes to OpenAI, `"claude-sonnet-4"` to Anthropic,
`"gemini-2.5-flash"` to Gemini, `"ollama/qwen3"` to a local Ollama.

### Choosing a model

| Form | Example | Notes |
|---|---|---|
| Known prefix | `gpt-4.1-mini`, `claude-sonnet-4`, `gemini-2.5-flash` | An unchanged OpenAI client just works. |
| Explicit prefix | `openai/gpt-4.1-mini`, `ollama/qwen3` | Unambiguous, and the only way to reach Ollama — its model names are arbitrary. |
| Namespaced | `openai/meta-llama/Llama-3-70B` | Only the first slash is the provider; the rest is the model. |

An unrecognised bare name is **refused, not guessed at** — guessing would send your request,
and your money, to a provider you did not choose.

Ollama is optional and off by default:

```bash
docker compose --profile ollama up
```

---

## Architecture

A **modular monolith**: one deployable process with deliberate internal boundaries.

```text
                            ┌─────────────────────────┐
  client ───────────────────│  Fastify HTTP API       │
  (OpenAI-compatible SDK)   │                         │
                            │  request context        │  requestId / traceId
                            │  authentication         │  API key → hash lookup
                            │  rate limiting          │  Redis token bucket
                            │  validation             │  Zod
                            └───────────┬─────────────┘
                                        │  ChatRequest
                            ┌───────────▼─────────────┐
                            │  Router                 │
                            │                         │
                            │  model resolution       │  explicit → alias → route
                            │  fallback               │  a DIFFERENT provider
                            │  retry                  │  the SAME provider
                            │  timeouts               │  per call + per request
                            └───────────┬─────────────┘
                                        │  provider-native
                            ┌───────────▼─────────────┐
                            │  LLMProvider            │
                            │  OpenAI · Anthropic ·   │
                            │  Gemini · Ollama · Mock │
                            └───────────┬─────────────┘
                                        │
              ┌─────────────────────────┴───────────────────────┐
              │                                                 │
      ┌───────▼────────┐                              ┌─────────▼────────┐
      │  Redis         │                              │  PostgreSQL      │
      │  rate limits   │                              │  api_keys        │
      │  response cache│                              │  requests        │
      │  provider health│                             │                  │
      └────────────────┘                              └──────────────────┘
```

### Why a monolith

Every layer above shares one request lifecycle and one latency budget. Splitting routing from
providers across a network boundary would add a hop, a serialization step and a new failure mode
to a path whose entire job is being a thin, reliable proxy.

The boundaries exist so extraction is *possible* later — not because it is planned. That is the
only justification for a boundary at this stage.

### The request path

```text
POST /v1/chat/completions
  │
  ├─ normalize            OpenAI body → internal ChatRequest
  ├─ resolve              "fast" → [gemini-2.5-flash, gpt-4.1-mini]
  │
  └─ for each target:                        ← fallback  (failoverable errors)
       └─ for each attempt on that target:   ← retry     (retryable errors)
            └─ one provider call             ← PROVIDER_TIMEOUT_MS
     ...all bounded by                       ← REQUEST_TIMEOUT_MS
  │
  ├─ denormalize          provider response → OpenAI body
  └─ record               metadata only, buffered off the request path
```

Retries are exhausted on a target before moving on, so a single-target route still recovers from
a blip and a multi-target route does not skip past a provider that was one retry from succeeding.

### The error model is the load-bearing piece

Every provider translates its native failures into one taxonomy, and the router makes decisions
from **two independent flags** — never from a provider's status codes or message text:

| Code | Retry same provider | Try a different one | Why |
|---|---|---|---|
| `INVALID_REQUEST` | no | no | Fails identically everywhere |
| `INTERNAL_ERROR` | no | no | Our bug — same result anywhere |
| `AUTHENTICATION_ERROR` | no | **yes** | Our key won't fix itself; another provider has its own |
| `MODEL_NOT_FOUND` | no | **yes** | Same provider still lacks it; another may have an equivalent |
| `TIMEOUT` | no | **yes** | Hammering a slow provider rarely helps |
| `RATE_LIMITED` | **yes** | **yes** | Transient; others likely have capacity |
| `PROVIDER_ERROR` | **yes** | **yes** | Provider-side 5xx, often transient |
| `UNAVAILABLE` | **yes** | **yes** | DNS failure, connection refused, circuit open |

Collapsing these into one flag forces a choice between failing requests a configured fallback
could have served, and burning attempts on errors that cannot improve.

### Everything degrades toward staying up

| Dependency fails | What happens |
|---|---|
| Redis (rate limiter) | requests allowed, `x-openllm-ratelimit-degraded: true`, warning logged |
| Redis (cache) | treated as a miss |
| Redis (circuit breaker) | treated as closed |
| Postgres (request recording) | metrics dropped, request unaffected |
| Postgres / Redis (readiness) | `/ready` → 503, `/health` stays 200 |

These are cost and latency optimisations; none is worth being the reason the gateway is down.
The rate limiter's degraded state is surfaced in a header *and* a log, because silently not
limiting is how an unexpected bill arrives.

### Two invariants

**Prompts and completions are never persisted.** Not "not populated" — the `requests` table has
no column for them, and a test asserts none exists so the guarantee survives a future migration.

**API keys are stored only as hashes**, and the raw key is returned exactly once at creation.
No endpoint can print it again.

### Repository layout

```text
apps/gateway/src/
  config/          env schema → typed AppConfig (the only place process.env is read)
  http/            server builder, plugins, routes, SSE
  routing/         model resolution, route table, retry, fallback, deadlines
  providers/       LLMProvider + adapters, transport, stream parsers
  redis/           rate limiter, response cache, circuit breaker
  observability/   logger, pricing, request recorder + repository
  auth/            key generation, hashing, repository
  db/              Drizzle schema + migrator

apps/dashboard/    operator UI (React, Vite, Tailwind, TanStack Query)
packages/core/     shared with the dashboard: error taxonomy, correlation IDs, provider ids
docker/            gateway and dashboard images, nginx config
docs/              PLAN.md (decisions + phase history), architecture.md, configuration.md
```

`packages/core` holds only what the gateway **and** the dashboard both import — a package earns
its existence by having two consumers.

**Deeper detail, and the reasoning behind each decision:**
[docs/architecture.md](docs/architecture.md) · [docs/PLAN.md](docs/PLAN.md)

## Local development

Requires Node 24 (see `.nvmrc`) and pnpm 10.

```bash
corepack enable pnpm          # or: npm install -g pnpm

pnpm install
docker compose up -d postgres redis   # datastores only
cp .env.example .env
pnpm dev                              # tsx watch on http://localhost:4000
```

### Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the gateway with watch-reload |
| `pnpm build` | Compile all workspace packages |
| `pnpm typecheck` | Type-check sources and tests |
| `pnpm lint` | ESLint across the workspace |
| `pnpm test` | Unit tests — no Docker required |
| `pnpm test:coverage` | Unit tests with a coverage report |
| `pnpm test:integration` | Integration tests against live Redis/Postgres |
| `pnpm db:generate` / `pnpm db:migrate` | Drizzle migrations |
| `pnpm key:create "name"` | Mint an API key |
| `pnpm --filter @openllm/dashboard dev` | Dashboard on :5173, proxying to the gateway |

Integration tests are opt-in because they need real infrastructure:

```bash
docker compose up -d postgres redis
INTEGRATION_TESTS=1 pnpm test:integration
```

**No test requires a provider API key or network access.** Every adapter takes its `fetch`
by injection, so a contributor with no OpenAI, Google, or Anthropic account can run the
entire suite.

### Testing without spending credits

A built-in mock provider (enabled outside production) exercises the failure paths that are
otherwise hard to reproduce on demand. The behaviour is chosen by the model name:

| Model | Behaviour | Retryable |
|---|---|---|
| `mock` / `mock/echo` | success / echoes your last message | — |
| `mock/rate-limited` | 429 | yes |
| `mock/server-error` | 500 | yes |
| `mock/unavailable` | 503 | yes |
| `mock/invalid` | 400 | **no** |
| `mock/auth-error` | 401 | **no** |
| `mock/model-not-found` | 404 | **no** |
| `mock/timeout` | never responds | — |

Waiting for a real provider to rate-limit you is not a test strategy, and paying for tokens
to assert a 429 is worse.

---

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | **Liveness.** Is this process wedged? Checks nothing external. |
| `GET /ready` | **Readiness.** Should traffic be routed here? Checks Postgres and Redis. |
| `POST /v1/chat/completions` | OpenAI-compatible chat, buffered or streamed (`stream: true`). |
| `GET /v1/models[/:id]` | OpenAI-compatible model listing — the aliases and routes you configured, plus the models they resolve to, filtered to providers you hold a credential for. **Not exhaustive:** any name a provider prefix matches is routable whether or not it appears here, and with no `openllm.yaml` the list is empty. Enumerating every provider's catalogue would make this endpoint's availability depend on all of them at once. |
| `POST`/`GET`/`DELETE /v1/admin/keys` | Key management. Requires `ADMIN_API_KEY`. |
| `GET /v1/admin/stats/*` | Summary, per-provider, per-bucket time series, filter facets. Read-only credential. |
| `GET /v1/admin/requests[/:id]` | Recent requests and request detail. Filterable by `status`, `provider` and `model`; paged with an opaque `cursor`. Read-only credential. |
| `GET /v1/admin/traces/:traceId` | Every request sharing a trace. Read-only credential. |

### Model aliases and fallback

Copy `openllm.example.yaml` to `openllm.yaml` and clients can ask for `fast` instead of naming
a provider's model:

```yaml
routes:
  fast:
    strategy: fallback
    models:
      - gemini-2.5-flash
      - gpt-4.1-mini
```

Targets are tried in order. The gateway moves on only when the failure is something a
different provider could plausibly fix — rate limits, outages, timeouts, unknown models, bad
credentials. A malformed request fails identically everywhere, so it comes straight back
rather than being replayed at four providers for four identical 400s.

Fallback works for streaming too: because the gateway pulls the first chunk before committing
to a `200`, a rate-limited provider is swapped out invisibly and the client sees one clean
stream.

Responses carry `x-openllm-provider`, and `x-openllm-attempts` when a fallback fired. Routes
are validated at startup, so a typo'd route fails the deploy instead of an incident.

### Authentication

Keys look like `olgm_live_…` and go in the usual header:

```bash
curl localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer $OPENLLM_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"mock","messages":[{"role":"user","content":"hi"}]}'
```

Create one:

```bash
pnpm key:create "my-app"     # or, in Docker:
docker compose exec gateway node apps/gateway/dist/cli/create-key.js "my-app"
```

**The key is shown exactly once.** Only a SHA-256 hash is stored, so a database dump does not
let anyone call your gateway — and there is no endpoint that can print it again.

Auth is **on in production and off elsewhere**, so the quickstart above works before any key
exists. When it is off, the gateway logs a warning at startup; that state should never be
quiet. `/health` and `/ready` are always public — an orchestrator cannot hold a key, and if
liveness needed one a bad secret would make Kubernetes kill every pod.

Set `ADMIN_API_KEY` to enable key management over HTTP (`POST`/`GET`/`DELETE /v1/admin/keys`).
That secret lives only in the environment, never in the database, so a database compromise
cannot mint new credentials. Revocation takes effect immediately — there is deliberately no
auth cache.

### Dashboard

```bash
docker compose up      # dashboard on http://localhost:3000
```

Totals, success rate, average **and p95** latency, tokens, estimated cost, a provider
breakdown, recent requests and per-request detail. p95 is there because an average hides the
tail, and the tail is what people mean when they say the gateway feels slow.

Above the tables, one chart: requests per time bucket, split into successes and errors. It is
there because a success rate cannot tell you whether the failures are spread across the window
or all arrived in the last four minutes. Empty buckets are drawn rather than skipped, so an
idle period looks idle instead of disappearing.

The request table filters by status, provider and model — the options are the values that
actually served traffic in the selected window, not everything configured — and pages through
history with a "Load more" that is immune to rows shifting underneath it. Trace IDs are
copyable in one click, because a trace ID is only ever useful somewhere else. Rows are
reachable by keyboard, and auto-refresh shows its state, pauses on demand, and stops on its own
once you page back into history.

It asks for `DASHBOARD_API_KEY`, which is **read-only** — the gateway will not accept it for
key management. That separation is deliberate: whatever credential a browser app holds is one
XSS away from being someone else's, and the blast radius of this one is "can read request
metadata". The key lives in `sessionStorage`, so closing the tab clears it.

nginx serves the SPA and proxies `/v1` to the gateway, so the browser is same-origin with the
API — which is why there is no CORS configuration anywhere in this project.

The dashboard shows no prompts or completions. Not filtered — never stored.

> It is an operator tool. Bind it to a trusted network; do not expose it publicly.

### Request records and cost

Every request writes one metadata row: request and trace IDs, provider, model, route, status,
error code, latency, provider calls, token counts and estimated cost.

```sql
select provider, count(*), round(avg(latency_ms)) avg_ms, sum(estimated_cost_usd) est_cost
from requests where created_at > now() - interval '1 hour' group by provider;
```

**There is no prompt column and no completion column** — not "we don't fill them in", they do
not exist. A nullable `prompt` column is one somebody eventually populates "just for
debugging". An integration test asserts no content-shaped column exists, so the guarantee
survives a future migration.

Writes are buffered and batched **off the request path**. An awaited INSERT per request would
put Postgres in the critical path of an API whose job is proxying somebody else's — a slow
database would mean a slow gateway. A write failure loses metrics, which is the right thing to
lose. The buffer is bounded and flushed on shutdown.

**History is pruned automatically.** `REQUEST_RETENTION_DAYS` defaults to 90 — a table nothing
ever deletes from grows until queries crawl. Pruning is batched, guarded by an advisory lock so
only one replica does it, and bounded per run so it never becomes a long-running transaction.
Set it to `0` to keep everything forever.

Set per-model pricing in `openllm.yaml` (USD per million tokens). A model with no entry records
**NULL cost, never zero** — "we don't know" and "it was free" are different statements, and
zero-filling makes every total understate the bill in a way that looks like good news.

The figures are labelled **estimates** because they are: cached-input discounts, batch rates,
reasoning-token rules and negotiated pricing are all invisible from here.

### Rate limiting

Enabled by default at 60 requests/minute, keyed by API key (or client IP when auth is off):

```
x-ratelimit-limit-requests: 60
x-ratelimit-remaining-requests: 41
retry-after: 3            # on a 429
```

It's a **token bucket evaluated inside Redis by a Lua script**, for two reasons. A fixed window
lets a caller send a full window at `11:59:59` and another at `12:00:00` — "60/minute" that
permits 120 in a second. And read-modify-write across a network is a race: without atomicity,
concurrent requests each see "1 token left" and all proceed. *Verified: 20 concurrent requests
against a bucket of 5 produce exactly 5 successes.*

The bucket also takes a per-request **cost**, which is how tokens/minute will work later —
same implementation, cost N instead of 1.

**If Redis goes down, requests still flow.** The limiter fails open by default, sets
`x-openllm-ratelimit-degraded: true` and logs a warning. A limiter that rejects everything
during a Redis blip is itself the outage.

### Response cache (opt-in)

`CACHE_ENABLED=true` caches exact-match requests, keyed by model, messages and all sampling
parameters. Responses carry `x-openllm-cache: hit|miss`.

It is **off by default on purpose**: enabling it stores completion text in Redis until the TTL
expires, and privacy-first is the default. It also makes repeated identical calls deterministic
even at `temperature: 1` — usually the point, but a behaviour change rather than a free
optimisation.

### Provider circuit breaker

After `BREAKER_FAILURE_THRESHOLD` consecutive failures a provider is skipped for a cooldown,
so a dead provider stops adding its full timeout to every request. State lives in Redis, so
replicas learn from each other.

Two guardrails: a Redis failure means the circuit is treated as **closed** — a monitoring
dependency must never block traffic — and if *every* target looks unhealthy the router tries
anyway, since a guaranteed failure is worse than a probably-failing attempt.

### Retries and timeouts

Transient failures are retried on the same provider before falling over to a different one:

```
for each target in the route:      ← fallback  (a different provider)
  for each attempt on that target: ← retry     (the same provider)
    one provider call              ← PROVIDER_TIMEOUT_MS
...all bounded by                  ← REQUEST_TIMEOUT_MS
```

Backoff is `250ms → 500ms → 1000ms`, capped, and **jittered by default** — without jitter,
every client that hit the same outage retries at the same instant and re-creates the spike.
When a provider sends `Retry-After`, that wins over our guess.

The two timeouts are deliberately separate. `PROVIDER_TIMEOUT_MS` bounds one call;
`REQUEST_TIMEOUT_MS` bounds everything. Without the second, three targets at three attempts
each could run for minutes on behalf of a caller who gave up long ago — that budget is what
makes retry and fallback safe to leave on.

Nothing retryable is retried blindly: a malformed request comes straight back, and retries
stop early when the remaining budget cannot fit another backoff plus another call.

### Streaming

Set `stream: true` and the response arrives as Server-Sent Events in OpenAI's chunk format,
terminated by `data: [DONE]`:

```bash
curl -N localhost:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"one two three"}],"stream":true}'
```

Token counts come back in a trailing chunk only if you ask for them, matching OpenAI:

```json
{ "stream": true, "stream_options": { "include_usage": true } }
```

Three behaviours worth knowing:

- **Failures before the first token are real status codes.** A rate-limited provider gives you
  `429 application/json`, not a `200` whose body happens to contain an error. The gateway pulls
  the first chunk from the provider before committing to a 200 — after that the status is fixed.
  A failure *mid-stream* can only be an SSE error event, and the stream then closes **without**
  `[DONE]`, so a truncated response is never mistaken for a complete one.
- **Hanging up stops the meter.** Closing the connection aborts the upstream provider call
  rather than leaving it generating tokens you would still be billed for.
- **Deploys don't cut streams off.** On `SIGTERM`, in-flight streams get
  `SHUTDOWN_STREAM_GRACE_MS` to finish before anything closes.

If a proxy sits in front of the gateway, streaming depends on it not buffering. The gateway
sends `x-accel-buffering: no` and `cache-control: no-transform` for this reason. To verify your
setup end to end, set `MOCK_CHUNK_DELAY_MS=120` and watch chunks arrive spaced out rather than
all at once.

### What the gateway refuses, and why

Unknown request fields are ignored — real OpenAI SDKs send `user`, `seed`,
`presence_penalty` and more, and rejecting them would break the compatibility promise for
clients doing nothing wrong.

But four are refused with a clear `400` rather than silently dropped, because each one
changes what a correct answer looks like:

| Field | Why not ignore it |
|---|---|
| `tools` / `functions` | Dropping them yields a confidently wrong answer instead of a tool call. |
| `response_format` | Silently ignoring JSON mode returns prose where the caller will parse JSON. |
| `n > 1` | The caller would get fewer choices than they asked for, with no signal. |

Errors always come back in the OpenAI envelope, including the request id:

```json
{ "error": { "message": "...", "type": "rate_limit_error",
             "code": "RATE_LIMITED", "request_id": "req_..." } }
```

`usage` is **omitted** when the provider reported none — a deliberate deviation from OpenAI,
which always sends it. Reporting zeroes would be a lie that understates your cost.

### Why liveness and readiness are separate

This distinction is load-bearing, not ceremony.

If `/health` checked Redis, a thirty-second Redis blip would cause your orchestrator to
**kill and restart every gateway instance** — escalating a partial degradation into a
total outage and dropping every in-flight request along the way.

- `/health` answers *"is this process broken?"* → restart me.
- `/ready` answers *"can I serve traffic right now?"* → stop routing to me.

`/ready` returns `503` with a per-dependency breakdown, so you can see *which*
dependency is down:

```json
{
  "status": "not_ready",
  "state": "ready",
  "checks": {
    "redis":    { "status": "down", "latencyMs": 2001, "error": "redis ping timed out after 2000ms" },
    "postgres": { "status": "up",   "latencyMs": 4 }
  }
}
```

Every response carries `x-request-id` and `x-trace-id`. If you supply your own
`x-trace-id`, the gateway adopts it so your trace and ours stay joined.

---

## Graceful shutdown

On `SIGTERM` the gateway does **not** close the server immediately — that would
connection-refuse requests the load balancer had already dispatched, which is the classic
"deploys cause a blip of 502s" bug.

```
SIGTERM
  → /ready starts returning 503   (load balancer stops routing here)
  → wait SHUTDOWN_DRAIN_MS
  → close HTTP server             (in-flight requests finish)
  → close Redis
  → close Postgres
  → exit
```

A hard `SHUTDOWN_TIMEOUT_MS` deadline guarantees the process exits rather than becoming a
zombie the orchestrator has to `SIGKILL`.

---

## Privacy and security

These are commitments, not aspirations — they hold at every phase.

- **Prompts and completions are never stored.** The request table records metadata only:
  provider, model, status, latency, token counts, estimated cost. There is no column for
  message content. Content logging will be opt-in via explicit configuration, never a default.
- **API keys are stored only as hashes.** A key is shown exactly once, at creation.
  A database dump does not let anyone call your gateway.
- **Provider credentials are never exposed** through the API or the dashboard.
- **Secrets are never logged.** `Authorization`, `x-api-key`, cookies, and anything named
  like a token are stripped in the base logger configuration — enforced by config, not by
  reviewer vigilance.
- **CORS is disabled by default**, not wildcarded. An empty `CORS_ORIGINS` means no
  cross-origin access, not "allow everything".
- Request bodies are size-capped and every provider call will be time-bounded.

---

## Configuration

Everything is environment variables, validated with Zod at boot. Invalid configuration
fails the process at startup — with *every* problem reported at once, not one per restart.

See [docs/configuration.md](docs/configuration.md) for the full reference and
[.env.example](.env.example) for a working starting point.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and read [docs/PLAN.md](docs/PLAN.md) first — it
defines scope and the architectural decisions considered settled. If code and that document
disagree, the disagreement gets resolved there before it gets resolved in code.

Two rules worth knowing before you start: **no test may require a provider API key or network
access**, and **integration tests share one database, so scope the rows you insert and delete**.

## License

Apache-2.0
