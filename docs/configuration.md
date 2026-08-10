# Configuration

All configuration is environment variables, validated with Zod at startup by
[`apps/gateway/src/config/env.ts`](../apps/gateway/src/config/env.ts).

**Invalid configuration stops the process.** Every problem is reported at once — fixing one
bad variable, redeploying, and discovering the next is a loop nobody should have to run:

```
Invalid configuration:
  - DATABASE_URL: DATABASE_URL is required
  - REDIS_URL: REDIS_URL is required
  - PORT: Expected number, received nan
```

Start from [`.env.example`](../.env.example).

---

## Runtime

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production`. Controls pretty-printed vs JSON logs. |
| `HOST` | `0.0.0.0` | **Must** be `0.0.0.0` inside a container — binding `127.0.0.1` makes the service unreachable from outside it. |
| `PORT` | `4000` | 1–65535. |
| `LOG_LEVEL` | `info` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`. An unrecognised value fails at boot rather than silently defaulting. |

## Datastores

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | *required* | Postgres connection string. |
| `REDIS_URL` | *required* | Redis connection string. |

Under `docker compose`, both are set by the compose file to point at the compose services.
The values in `.env` apply when running the gateway directly (`pnpm dev`).

## Postgres pool

| Variable | Default | Notes |
|---|---|---|
| `POSTGRES_POOL_MAX` | `10` | Bounded on purpose. An unbounded pool does not apply backpressure under load — it opens connections until Postgres refuses them, turning a traffic spike into an outage for every client of that database. |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | `5000` | How long to wait for a connection from the pool. |
| `POSTGRES_IDLE_TIMEOUT_MS` | `30000` | Idle connections are released, so the gateway does not hold connections it is not using. |

## HTTP

| Variable | Default | Notes |
|---|---|---|
| `BODY_LIMIT_BYTES` | `1048576` (1 MiB) | Rejects oversized bodies with `413`, normalized to an `INVALID_REQUEST` envelope. Raise this deliberately if you expect large prompts. |
| `CORS_ORIGINS` | `""` | Comma-separated allowlist, whitespace trimmed. **Empty means CORS is disabled, not "allow all".** CORS is only registered when at least one origin is configured. |

## Readiness probe

| Variable | Default | Notes |
|---|---|---|
| `READINESS_CHECK_TIMEOUT_MS` | `2000` | Per-dependency deadline, enforced by the probe itself rather than trusted to each client. A probe that hangs is worse than one that reports failure. |
| `READINESS_CACHE_MS` | `1000` | Result cache. Without it, a load balancer polling at 10rps generates a constant background load of `SELECT 1` and `PING` against production infrastructure. Set to `0` to disable (tests do). |

## Reliability

There are **two** timeouts, and conflating them is the mistake:

| Variable | Default | Notes |
|---|---|---|
| `PROVIDER_TIMEOUT_MS` | `30000` | Ceiling on a **single** provider call (spec §10). Enforced with an `AbortSignal`, which actually cancels the upstream HTTP request — racing a timer would only abandon the promise while the provider kept generating, and billing, tokens nobody will read. Rebuilt per attempt, since one shared timeout would be consumed by the first try and kill every retry after it. |
| `REQUEST_TIMEOUT_MS` | `60000` | Ceiling on the **whole** operation, retries and fallbacks included. Without it, reliability features multiply latency instead of improving it: three targets at three attempts each is nine calls plus eight backoff waits — several minutes for a caller who gave up after ten seconds. This budget is what makes retry and fallback safe to leave on by default. |

### Retry (spec §9)

Attempts are per target; fallback then moves to the next provider. Retries are exhausted on a
target before moving on, so a single-target route still recovers from a blip and a
multi-target route does not skip past a provider that was one retry away.

| Variable | Default | Notes |
|---|---|---|
| `RETRY_MAX_ATTEMPTS` | `3` | Total attempts per target, including the first. `1` disables retrying. |
| `RETRY_BASE_DELAY_MS` | `250` | Backoff is `base × 2^(attempt-1)`: 250ms, 500ms, 1000ms … |
| `RETRY_MAX_DELAY_MS` | `5000` | Cap. Without it, attempt 10 would wait over two minutes. |
| `RETRY_JITTER` | `true` | Randomizes the delay (equal jitter: half fixed, half random, so the schedule above stays the expected value). Matters more than it looks — without it every client that hit the same outage retries at the same instant, re-creating the spike. A gateway sits in front of many callers, so it would be amplifying the herd rather than absorbing it. |

**A provider's `Retry-After` beats our guess.** When one is sent, it is used as-is instead of
the exponential curve — the provider knows its actual limit; our curve is a model. Retry log
lines carry `honouredRetryAfter` so you can tell which happened.

**Retries stop early** when the remaining request budget cannot fit the backoff plus another
call. Sleeping only to then abandon the request wastes everyone's time; giving up leaves what
remains for a different provider.

Responses carry `x-openllm-attempts` — total provider calls, counting retries *and* failovers.

## Graceful shutdown

| Variable | Default | Notes |
|---|---|---|
| `SHUTDOWN_DRAIN_MS` | `5000` | Time spent returning `503` from `/ready` before the HTTP server closes, so the load balancer stops routing here first. **This is what makes deploys blip-free.** Set it to at least your load balancer's unhealthy threshold × check interval. |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Hard deadline for the whole sequence. On expiry the process exits `1` rather than becoming a zombie the orchestrator must `SIGKILL`. |
| `SHUTDOWN_STREAM_GRACE_MS` | `10000` | How long in-flight **streamed** responses get to finish before being aborted. Ordinary requests complete in milliseconds, so `app.close()` handles them; a streamed completion can run for tens of seconds, and severing it mid-sentence discards work the user has already been billed for. Streams are drained *before* the HTTP server closes, otherwise `close()` would simply block on them. |

If you raise any of these, also raise `stop_grace_period` in `docker-compose.yml`
(and `terminationGracePeriodSeconds` in Kubernetes). It must exceed
`SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS`, or the container is killed mid-drain and the
careful shutdown accomplishes nothing.

## Providers

**A provider is enabled when its credential is configured** — an API key for the hosted
providers, a base URL for Ollama. There is no separate `*_ENABLED` flag: a provider that is
"enabled" with no way to authenticate is not a state worth being able to express, and it is
the state that produces confusing 502s at 3am.

Enabled providers are logged at startup (IDs only, never keys), so a misconfiguration is
visible in the boot log rather than discovered by the first real request.

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | *unset* | Setting it enables OpenAI. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Override to target any OpenAI-compatible server — vLLM, LM Studio, Together, an internal proxy. |
| `GEMINI_API_KEY` | *unset* | Setting it enables Gemini. Sent as an `x-goog-api-key` header, never as a `?key=` query parameter — keys in URLs end up in access and proxy logs. |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta` | |
| `ANTHROPIC_API_KEY` | *unset* | Setting it enables Anthropic. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com/v1` | |
| `ANTHROPIC_VERSION` | `2023-06-01` | Sent as `anthropic-version`. Pinned so an API change upstream cannot silently alter behaviour. |
| `OLLAMA_BASE_URL` | *unset* | Setting it enables Ollama. **No default on purpose**: a default would enable Ollama on every machine and make its health checks fail wherever it was never installed (spec §19 makes it optional). |

Trailing slashes on base URLs are stripped, so `https://proxy/v1/` and `https://proxy/v1`
behave identically.

### Mock provider

Exists to exercise retries, fallback, timeouts and rate limiting without spending API
credits (spec §17). Used heavily by the test suite.

| Variable | Default | Notes |
|---|---|---|
| `MOCK_PROVIDER_ENABLED` | `true` outside production | **Off in production by default.** A mock silently reachable in production would let a misconfiguration return fabricated completions to real users. Accepts `true`/`false`/`1`/`0`. |
| `MOCK_LATENCY_MS` | `0` | Artificial delay before responding. |
| `MOCK_CHUNK_DELAY_MS` | `0` | Delay between streamed chunks. Set it to ~120 to watch SSE arrive incrementally — and to prove a proxy in front of the gateway is not buffering the whole stream. |
| `MOCK_FAILURE_RATE` | `0` | Probability (0–1) that any call fails with a retryable error. |

Per-request behaviour is driven by the model name, which keeps test scenarios visible in the
request rather than buried in setup:

| Model | Behaviour | Retryable |
|---|---|---|
| `mock` | success | — |
| `mock/echo` | returns your last user message | — |
| `mock/rate-limited` | `RATE_LIMITED` | yes |
| `mock/server-error` | `PROVIDER_ERROR` | yes |
| `mock/unavailable` | `UNAVAILABLE` | yes |
| `mock/invalid` | `INVALID_REQUEST` | **no** |
| `mock/auth-error` | `AUTHENTICATION_ERROR` | **no** |
| `mock/model-not-found` | `MODEL_NOT_FOUND` | **no** |
| `mock/timeout` | never responds until aborted | — |

An unrecognised suffix (`mock/llama3`) is treated as an ordinary model name and succeeds.

## Redis features (spec §12)

Every key is `{prefix}:{version}:{feature}:{…}` — for example
`openllm:v1:rl:key:3f2a…`. The prefix lets several gateways share one Redis; the **version**
is there so a rolling deploy cannot have new code reading old values in a changed format and
misbehaving silently for the length of the rollout.

| Variable | Default | Notes |
|---|---|---|
| `REDIS_KEY_PREFIX` | `openllm` | Namespace for all keys. |

### Rate limiting

A **token bucket**, evaluated by a Lua script inside Redis.

*Why a bucket rather than a fixed window:* spec §12 wants requests/minute now and
tokens/minute later. A bucket gives both from one implementation — the cost of a request is a
parameter, so requests/minute is cost 1 and tokens/minute is cost N. A fixed window also lets a
caller send a full window at `11:59:59` and another at `12:00:00`, so "60/minute" permits 120
in one second; a bucket refills continuously and has no boundary to exploit.

*Why Lua:* read-modify-write across a network is a race. Two concurrent requests both read "1
token left", both proceed, and the limit is breached — exactly what §12 says to avoid. The
whole decision runs inside Redis as one atomic script. *Verified with 20 concurrent requests
against a bucket of 5 producing exactly 5 successes.*

*Why the Redis clock:* with several replicas, clock skew between them would refill buckets
inconsistently. `redis.call('TIME')` is the one clock they all agree on.

| Variable | Default | Notes |
|---|---|---|
| `RATE_LIMIT_ENABLED` | `true` | |
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | `60` | Sustained rate. |
| `RATE_LIMIT_BURST` | = the rate | Bucket size. Defaults so "60/minute" behaves as expected. |
| `RATE_LIMIT_FAIL_OPEN` | `true` | Allow requests when Redis is unreachable. **On by default**: a limiter that rejects everything during a Redis blip converts a dependency wobble into a total outage. Responses carry `x-openllm-ratelimit-degraded: true` and a warning is logged, so it is never a silent state. Set `false` where exceeding the limit is worse than being unavailable. |

Limits are keyed by **API key** when auth is on, falling back to client IP when it is off.
Responses carry OpenAI's header names (`x-ratelimit-limit-requests`,
`x-ratelimit-remaining-requests`, `x-ratelimit-reset-requests`) plus `retry-after` on a 429, so
existing client back-off handling works unchanged. `/health` and `/ready` are never limited —
an orchestrator must not be able to exhaust a budget and get the instance killed.

### Response cache

| Variable | Default | Notes |
|---|---|---|
| `CACHE_ENABLED` | **`false`** | See the warning below. |
| `CACHE_TTL_SECONDS` | `300` | |
| `CACHE_SCOPE` | `global` | `global` shares entries across callers; `api-key` isolates them. Sharing is safe — a hit requires sending the byte-identical prompt — but some deployments prefer isolation regardless. |

> **Enabling the cache stores completion text in Redis.** Cache keys are SHA-256 hashes, so
> prompts are not recoverable from keys — but the stored *values* contain completions in clear
> text, readable by anyone with access to that Redis. Privacy-first is the default (spec §14,
> §26), which is why this is opt-in rather than on.
>
> It also **changes semantics**: repeated identical requests become deterministic even at
> `temperature: 1`. Usually that is the point, but it is a behaviour change rather than a
> transparent optimisation.

The key covers model, messages, temperature, `max_tokens`, `top_p` and stop sequences —
anything omitted would be a correctness bug, since two different requests would collide.
Streaming is never cached: replaying a stream instantly delivers none of the incremental
behaviour the client asked for. Every response carries `x-openllm-cache: hit|miss`; "miss" is
sent explicitly even when caching is off, because a missing header would be ambiguous.

### Provider circuit breaker

When a provider is down, every request pays its timeout before failing over — with a 30s
timeout that is 30 seconds added to *every* request until someone notices. Tracking
consecutive failures stops that.

| Variable | Default | Notes |
|---|---|---|
| `BREAKER_ENABLED` | `true` | |
| `BREAKER_FAILURE_THRESHOLD` | `5` | Consecutive failures before the provider is skipped. |
| `BREAKER_COOLDOWN_SECONDS` | `30` | How long it stays skipped. Half-open comes free: the key expires, the next request tests the provider, and one success closes the circuit. |

State lives in Redis rather than process memory so replicas learn from each other and a
freshly started one is not ignorant. Two rules keep it from becoming a liability: **a Redis
failure means closed** (a monitoring dependency must never block traffic), and **never open
every path** — if all targets look unhealthy the router tries anyway, because a guaranteed
failure is worse than a probably-failing attempt and it is how the circuit recovers.

Only failoverable errors count. A malformed request would fail identically everywhere, so
counting it would let one bad client open circuits on every provider.

## Authentication (spec §13)

| Variable | Default | Notes |
|---|---|---|
| `AUTH_REQUIRED` | `true` in production, `false` elsewhere | Whether `/v1` needs an API key. The convenient default must not become the production default, so it flips on `NODE_ENV` — and a **warning is logged whenever it is off**, because "auth disabled" should never be a quiet state. `/health` and `/ready` are always public: an orchestrator cannot hold a key, and if liveness needed one a bad secret would make Kubernetes kill every pod. |
| `DASHBOARD_API_KEY` | *unset* | **Read-only** credential for the dashboard's stats endpoints (`/v1/admin/stats/*`, `/v1/admin/requests*`, `/v1/admin/traces/*`). Deliberately separate from `ADMIN_API_KEY`: the dashboard is a browser app, and whatever credential it holds is one XSS away from being someone else's — so it must not be one that can mint API keys. `ADMIN_API_KEY` also works on these routes, for curl and scripts. |
| `ADMIN_API_KEY` | *unset* | Secret for `/v1/admin`. **Environment only, never in the database** — so a database compromise yields hashes an attacker cannot reverse *and* no way to issue working credentials. Unset disables `/v1/admin` entirely (404, not 401 — an operator debugging a credential they never set is the worse outcome). Minimum 16 characters. |

Keys look like `olgm_live_<43 chars>` and are accepted as `Authorization: Bearer <key>` or
`x-api-key: <key>`.

### How keys are stored

Only a **SHA-256 hash**, plus a short clear-text prefix for display. The raw key is returned
exactly once, at creation, and exists nowhere afterwards. A database dump does not let anyone
call the gateway.

SHA-256 rather than bcrypt/argon2 is deliberate, and correct for this case:

- **Entropy.** Password hashing is slow to make brute-forcing *low-entropy, human-chosen*
  secrets expensive. These keys are 256 bits of CSPRNG output — there is no dictionary and no
  feasible brute force, however fast the function is.
- **Lookup.** bcrypt and argon2 salt per record, so their output cannot be an index key.
  Authenticating would mean loading every row and verifying against each; at ~100ms per verify
  that is a cap of a few requests per second, not a performance detail.

**No cache on the auth path.** One indexed lookup is ~1ms against provider calls measured in
hundreds, and skipping the cache means revocation takes effect *immediately* rather than after
a TTL. Worth more than the millisecond.

### Bootstrapping

```bash
pnpm key:create "my-app"                                   # local
docker compose exec gateway node apps/gateway/dist/cli/create-key.js "my-app"
```

The CLI exists because `/v1/admin` needs `ADMIN_API_KEY`, and an operator who has not set one
still needs a first key. It prints the key alone on stdout, so `KEY=$(pnpm -s key:create ci)`
works.

### Managing keys over HTTP

With `ADMIN_API_KEY` set:

| Endpoint | Purpose |
|---|---|
| `POST /v1/admin/keys` | Create. **The only response that ever contains a raw key.** |
| `GET /v1/admin/keys` | List — prefixes, status and usage only, never hashes. |
| `DELETE /v1/admin/keys/:id` | Revoke. Immediate. |

Revocation sets a status rather than deleting the row: request history (Phase 9) references
these keys, and "who made this call" must survive the key being turned off.

## Request recording (spec §14, §15)

One metadata row per request: request and trace IDs, provider, model, route, status, error
code, latency, provider call count, token counts and estimated cost.

**There is no prompt column and no completion column.** Not "we don't populate them" — they do
not exist, because a nullable `prompt` column is one somebody eventually fills in "just for
debugging". An integration test asserts the table has no content-shaped column, so the
guarantee survives a migration written in a hurry.

| Variable | Default | Notes |
|---|---|---|
| `REQUEST_RECORDING_ENABLED` | `true` | |
| `REQUEST_RECORDING_BATCH_SIZE` | `50` | Rows per INSERT. |
| `REQUEST_RECORDING_FLUSH_MS` | `1000` | Maximum time a record waits before being written. |
| `REQUEST_RECORDING_MAX_BUFFER` | `10000` | Past this the oldest records are dropped and counted. An unbounded buffer during a Postgres outage is just a slower crash that also loses everything already buffered. |

Writes are **buffered and batched entirely off the request path**. An awaited INSERT per
request would add a database round-trip to every call and put Postgres in the critical path of
an API whose whole job is proxying somebody else's — so a slow Postgres would make the gateway
slow, and a down Postgres would make it down, to save data nobody is reading right now. A write
failure loses metrics, which is the correct thing to lose.

The buffer is flushed on shutdown, after the HTTP server closes and before Postgres does.

### Retention

The `requests` table would otherwise grow forever. At 100 requests/second that is roughly 260
million rows a year, and every dashboard query gets slower until somebody notices — unbounded
growth in a table nothing deletes from is a latent outage, not a missing feature.

| Variable | Default | Notes |
|---|---|---|
| `REQUEST_RETENTION_DAYS` | `90` | Days of history to keep. **`0` keeps everything forever** — a reasonable choice if you ship this data to a warehouse, but not one to fall into by accident. The gateway logs a warning at startup when retention is off. |
| `REQUEST_PRUNE_INTERVAL_MS` | `3600000` (1h) | How often the pruner runs. |
| `REQUEST_PRUNE_BATCH_SIZE` | `5000` | Rows per `DELETE`. |

Three things make this safe against a live database:

- **Batched.** One `DELETE ... WHERE created_at < X` over millions of rows holds locks for the
  whole statement, writes an enormous WAL record and bloats the table. Small chunks let
  autovacuum keep up and let ordinary traffic interleave. Each statement deletes by primary key
  from a bounded subquery, so its lock footprint is predictable.
- **Lock-guarded.** Every replica runs the timer, so a `pg_try_advisory_lock` means exactly one
  prunes per round and the rest skip immediately. `try` rather than the blocking variant used
  for migrations — a replica that loses the race should serve traffic, not queue behind someone
  else's delete loop.
- **Bounded per run.** A capped number of batches, so a first run against a year of history
  makes progress and hands control back instead of becoming an hours-long transaction storm.

Pruning is off the request path entirely, and a failure is logged rather than propagated —
losing a prune round is not worth failing traffic over.

**At very high volume**, monthly partitioning with `DROP PARTITION` is cheaper than deleting
rows. That is a schema change rather than a setting, and it is not implemented here.

### Cost estimation (spec §16)

Pricing is **data, not code** — it lives in `openllm.yaml` so a price correction needs no
redeploy:

```yaml
pricing:
  gpt-4.1-mini:
    input: 0.40      # USD per million input tokens
    output: 1.60
```

Keys match exactly or by prefix, so `gpt-4.1-mini` covers `gpt-4.1-mini-2025-04-14`.

**Unknown pricing records NULL, never zero.** Zero is a claim ("this was free"); NULL is the
truth ("we don't know"). Zero-filling would make every aggregate understate the bill in a way
that looks like good news. `sum()` skips NULLs, so an unpriced model does not drag a total
toward zero either.

**The figures are estimates, and the column is named `estimated_cost_usd` to say so.** Provider
billing has nuances this model does not capture: cached input tokens are discounted and we
cannot see which of ours hit their cache; batch APIs are cheaper; reasoning tokens are billed
inconsistently; tiered and negotiated pricing is per-account. A gateway displaying these as
"cost" would be lying by a small, unauditable percentage.

Cost is stored as `NUMERIC(20,10)`, not a float — a request costs a fraction of a cent, and
float error accumulates precisely where the number matters most.

## Database migrations

| Variable | Default | Notes |
|---|---|---|
| `SKIP_MIGRATIONS` | `false` | Migrations run at boot. The alternative is a deploy that starts, serves 500s against a table that does not exist, and waits for someone to remember the manual step. Concurrent replicas are serialized by a **Postgres advisory lock**: the first migrates, the rest wait and find nothing to do. Set `true` where a deploy step runs `pnpm db:migrate` instead. |

## Model aliases and fallback routes

Nested lists do not fit in environment variables, so aliases and routes live in an optional
YAML file. **Credentials never appear in it** — config files get committed, and keys in them
get committed with them. The schema is strict, so `providers.openai.apiKey` is a validation
error rather than a silently ignored field.

| Variable | Default | Notes |
|---|---|---|
| `CONFIG_FILE` | *unset* | Path to the YAML file. When unset, `./openllm.yaml` then `./openllm.yml` are tried and their absence is fine. When **set**, a missing file is a startup error — you asked for that file, and booting with no routes would mean every aliased model 404s at runtime. |

Start from [`openllm.example.yaml`](../openllm.example.yaml):

```yaml
providers:
  gemini:
    enabled: false        # can only turn OFF what the environment enabled

models:                   # aliases (Level 2)
  fast:
    - gemini-2.5-flash
    - gpt-4.1-mini

routes:                   # the same thing with an explicit strategy (Level 3)
  balanced:
    strategy: fallback
    models:
      - gpt-4.1-mini
      - claude-sonnet-4
```

`models:` and `routes:` are two spellings of one idea. A name may appear under either, never
both — defining it twice is rejected at startup rather than silently resolved one way. A route
name that would shadow a real model (`gpt-4.1-mini`) is also rejected, since the shadowing
would be invisible from the request.

**Targets are validated at boot.** A model that cannot be routed to any provider stops
startup. Note the limit: this checks a provider can be *determined*, not that the model
exists — `gemini-2.5-flsah` matches the `gemini-` prefix and 404s at Google instead.

### When the gateway falls over to the next target

Only when a different provider could plausibly do better:

| Error | Retry same provider | Try next provider |
|---|---|---|
| `RATE_LIMITED`, `PROVIDER_ERROR`, `UNAVAILABLE` | yes | yes |
| `TIMEOUT` | no | **yes** |
| `MODEL_NOT_FOUND` | no | **yes** — another provider may have an equivalent |
| `AUTHENTICATION_ERROR` | no | **yes** — a different provider, a different credential |
| `INVALID_REQUEST`, `INTERNAL_ERROR` | no | **no** — fails identically everywhere |

A malformed request is returned immediately rather than replayed, or one bad request becomes
four charges for four identical 400s.

Falling over on `AUTHENTICATION_ERROR` masks a broken credential, so it logs at **warn** with
explicit "fix the credential" wording. Responses carry `x-openllm-provider` and, when a
fallback fired, `x-openllm-attempts`.

## Dashboard (spec §18)

```bash
docker compose up          # dashboard on http://localhost:3000
```

It asks for `DASHBOARD_API_KEY` and keeps it in `sessionStorage` — cleared when the tab closes,
so a shared or forgotten machine does not retain an operator credential.

**nginx serves the SPA and proxies `/v1` to the gateway.** The browser is therefore same-origin
with the API, which is why there is no CORS configuration anywhere in this project and the
gateway never needs to know the dashboard's address. The Vite dev server proxies identically,
so development and production behave the same.

The dashboard shows totals, success rate, average **and p95** latency, tokens, estimated cost, a
provider breakdown, recent requests and per-request detail. p95 is there because an average
hides the tail, and the tail is what people mean when they say the gateway feels slow.

Two things it deliberately does not do:

- **Show prompts or completions.** Not filtered out — never stored, so there is nothing to omit.
- **Round unknowns to zero.** A request whose model has no pricing shows `—`, and the cost tile
  says how many requests were unpriced. A total computed from a third of the traffic should not
  look authoritative.

> The dashboard is an operator tool. Bind it to a trusted network; do not expose it publicly.

## Compose-only variables

Used by `docker-compose.yml` for host port mapping, not by the application:

| Variable | Default |
|---|---|
| `GATEWAY_PORT` | `4000` |
| `POSTGRES_PORT` | `5432` |
| `REDIS_PORT` | `6379` |
| `OLLAMA_PORT` | `11434` |
| `DASHBOARD_PORT` | `3000` |
| `GATEWAY_BUILD_TARGET` | `runtime` — set to `dev` for watch-reloading |

---

## Planned

A YAML configuration file (spec §7) for providers, model aliases, and routing arrives with
Phase 6. `loadConfig()` is already shaped to merge it beneath the environment, with
environment variables taking precedence.
