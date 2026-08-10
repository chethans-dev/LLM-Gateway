# OpenLLM Gateway — Project Plan

> **This document is the source of truth for scope, sequencing, and locked decisions.**
> If an implementation disagrees with this file, one of the two is wrong — resolve it here first.
> Update this file whenever a decision changes. Do not let code drift from it silently.

---

## 1. What we're building

A self-hosted, open-source **LLM Gateway / AI infrastructure platform** exposing an
**OpenAI-compatible API** while routing requests across multiple LLM providers.

Providers (in build order): **Mock → OpenAI → Gemini → Ollama → Anthropic**

The target is a serious open-source infrastructure project with external contributors,
not a thin wrapper around provider SDKs.

**The compatibility promise:** an application already using an OpenAI-compatible SDK
should be able to change only its `baseURL` and keep working.

---

## 2. Architecture

```text
Client
  │
  ▼
Fastify HTTP API
  ├─ Request context (requestId / traceId)
  ├─ Authentication (API key)
  ├─ Rate limiting (Redis)
  ├─ Request validation (Zod)
  │
  ▼
Router
  ├─ Model resolution (explicit → alias → route)
  ├─ Retry (exponential backoff)
  ├─ Timeout
  └─ Fallback
  │
  ▼
Provider Abstraction  (LLMProvider)
  ├─ OpenAIProvider
  ├─ GeminiProvider
  ├─ AnthropicProvider
  ├─ OllamaProvider
  └─ MockProvider
  │
  ▼
Observability
  ├─ Redis      (rate limits, cache, provider health state)
  └─ PostgreSQL (api_keys, requests)
```

**Modular monolith.** One deployable process. No microservices. Boundaries are kept clean
so components *could* be extracted later — that's the only reason the boundaries exist.

---

## 3. Locked decisions

Changing any of these requires updating this section with the reason.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Lean package layout**: `apps/gateway`, `apps/dashboard`, `packages/core` | A package earns existence by having ≥2 consumers. Router/providers/observability stay as directories inside `apps/gateway/src` until a second consumer appears. Avoids build-ordering pain on empty packages. |
| D2 | **Drizzle ORM** (`drizzle-orm/node-postgres`) + drizzle-kit | Typed queries, schema-in-TS. Accepted tradeoff: schema truth lives in `.ts`, contributors need a `drizzle-kit generate` step. |
| D3 | **Two Vitest projects**, integration gated by `INTEGRATION_TESTS=1` against compose-backed infra | No extra deps, same containers used for dev. Unit tests run anywhere with zero infrastructure. |
| D4 | **`/health` = liveness, never checks dependencies. `/ready` = readiness, checks all deps.** | If liveness checks Redis, a Redis blip gets your gateway *killed and restarted* — a partial degradation becomes a full outage. |
| D5 | **ioredis** over node-redis | Rate limiting (Phase 8) needs atomic Lua; `defineCommand` gives `EVALSHA`/`SCRIPT LOAD` handling for free. Choosing now avoids a client migration. |
| D6 | **Zod everywhere** — HTTP validation via `fastify-type-provider-zod`, config, provider payloads | One schema language. Route handlers infer `request.body` from the schema, so runtime checks and compile-time types cannot drift. Ajv is faster but validation is nanoseconds against provider calls measured in hundreds of ms. |
| D7 | **Pure ESM, `NodeNext`, Node 24 LTS** | Avoids the dual-package hazard. `.nvmrc` and the Docker image both pin 24 so dev, CI, and prod match. |
| D8 | **Request/trace ID plumbing in Phase 1**, not Phase 9 | Retrofitting correlation IDs through an already-written router/retry/fallback stack means touching every file twice. Costs ~40 lines now. |
| D9 | **No orchestration framework** (no LangChain et al.) in the gateway core | This is infrastructure. Provider calls are HTTP requests behind our own interface. |
| D10 | **OpenTelemetry deferred**, but the request-context plugin is the seam it slots into | Adding OTel in v0.1 buys nothing until there's something worth tracing. |
| D11 | **Privacy-first by default**: prompts/completions never persisted; API keys stored only as hashes | Must be true from the first commit, not bolted on. |

---

## 4. Phase roadmap

Legend: ⬜ not started · 🟨 in progress · ✅ done

| Phase | Scope | Status |
|---|---|---|
| **1** | Repository & runtime foundation | ✅ |
| **2** | Provider abstraction + error model | ✅ |
| **3** | Providers: Mock, OpenAI, Anthropic, Gemini, Ollama | ✅ |
| **4** | API: `/v1/chat/completions` (non-streaming) | ✅ |
| **5** | Streaming (SSE) | ✅ |
| **6** | Routing: explicit model, aliases, fallback | ✅ |
| **7** | Reliability: retry, timeout | ✅ |
| **7.5** | API key authentication | ✅ |
| **8** | Redis: rate limiting, provider state, cache | ✅ |
| **9** | Observability: traces, metrics, Postgres persistence, cost | ✅ |
| **10** | Dashboard | ✅ |
| **11** | Testing hardening + documentation | ✅ |

### Deviations from the original spec ordering

Two items were moved because the original order was not in dependency order:

- **Error model (§23) moved Phase 7 → Phase 2.** Providers must normalize errors *as they
  are written* in Phase 3. Retry/fallback in Phase 7 then only *consumes* an existing taxonomy
  rather than forcing a rewrite of every provider.
- **API key auth (§13) inserted as Phase 7.5.** It had no phase number in the spec. Rate limiting
  is keyed by API key, so limiting without identity is meaningless. Auth must precede Phase 8.

### Phase exit criteria

| Phase | Done when… |
|---|---|
| 1 | `docker compose up` runs; `/health` 200 and `/ready` 200; stopping Redis makes `/ready` 503 while `/health` stays 200; SIGTERM drains cleanly; typecheck + lint + unit tests pass |
| 2 | `LLMProvider`, `ChatRequest`, `ChatResponse`, `ChatChunk`, `ProviderCapabilities`, and `LLMErrorCode` are defined and unit-tested; no provider implementations yet |
| 3 | Each provider implements the interface and maps its native errors to `LLMErrorCode`; MockProvider supports success/429/500/timeout/streaming/configurable latency |
| 4 | Non-streaming `POST /v1/chat/completions` returns an OpenAI-shaped response through MockProvider, end-to-end |
| 5 | `stream: true` emits SSE chunks terminated by `[DONE]`; client disconnect aborts the upstream provider call; no leaked handles |
| 6 | Explicit model, alias, and fallback resolution all covered by unit tests; fallback triggers only on retryable errors |
| 7 | Retry uses exponential backoff with the configured caps; invalid client requests are never retried; every provider call has a timeout |
| 7.5 | Keys issued as `olgm_live_*`, returned exactly once, stored only hashed; unauthenticated requests rejected |
| 8 | Rate limiting is atomic (Lua), keyed by API key with provider/model dimensions available; verified under concurrent load |
| 9 | Every request produces a persisted row with trace ID, tokens, latency, and estimated cost; no prompt content stored |
| 10 | Dashboard shows totals, provider breakdown, recent requests, and request detail |
| 11 | Full test matrix green with no real provider API keys required; README/docs accurate |

---

## 5. Phase 1 — Repository & runtime foundation ✅ complete

> Verified 2026-08-01: 43 unit tests + 4 integration tests pass, typecheck and lint clean,
> `docker compose up` reaches healthy, stopping Redis yields `/ready` 503 with `/health` 200,
> and SIGTERM drains for 5s then closes http → redis → postgres and exits 0.


Narrow by design: stand up the skeleton every later phase plugs into.
**Out of scope:** providers, `/v1/chat/completions`, streaming, routing, retry, auth,
rate limiting, caching, DB tables, cost, dashboard, OpenTelemetry.

### 5.1 Target structure

```text
openllm-gateway/
├── apps/
│   └── gateway/
│       ├── src/
│       │   ├── config/           env.ts (Zod env schema), config.ts (AppConfig)
│       │   ├── infra/            postgres.ts, redis.ts, shutdown.ts
│       │   ├── http/
│       │   │   ├── server.ts     buildServer(deps) -> FastifyInstance
│       │   │   ├── plugins/      request-context.ts, error-handler.ts
│       │   │   └── routes/       health.ts
│       │   ├── observability/    logger.ts (pino + redaction)
│       │   ├── db/               schema.ts (empty until Phase 8/9)
│       │   └── index.ts          entrypoint: wire deps, listen, trap signals
│       ├── test/
│       │   ├── unit/             config.test.ts, health.test.ts, shutdown.test.ts
│       │   ├── integration/      readiness.test.ts
│       │   └── helpers/          build-test-server.ts
│       ├── drizzle.config.ts
│       ├── tsconfig.json
│       └── package.json
│
├── packages/
│   └── core/                     errors.ts (LLMError + LLMErrorCode), types.ts
│
├── docker/gateway.Dockerfile     multi-stage: deps → build → dev | runtime
├── docs/                         PLAN.md (this file), architecture.md, configuration.md
├── .github/workflows/ci.yml
├── docker-compose.yml
├── .env.example
├── .nvmrc                        24
├── eslint.config.js
├── package.json                  workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.ts
└── README.md
```

**Why each piece exists**

- `packages/core` — the only code both gateway and dashboard will import. Deliberately tiny.
- `src/infra/` — every external connection exposes the same `ping()` / `close()` shape, so
  `ShutdownManager` and `/ready` treat Postgres and Redis identically and new deps plug in
  without editing either.
- `src/http/server.ts` — takes dependencies as arguments and returns a Fastify instance;
  it listens to nothing. This is what lets unit tests run it with fakes and integration tests
  run the *same* builder with real clients.
- `docker/` as a directory rather than a root `Dockerfile` — Phase 10 adds a dashboard image beside it.

### 5.2 TypeScript strictness

`tsconfig.base.json`, shared by all packages:

- `strict: true`
- `noUncheckedIndexedAccess` — `arr[i]` becomes `T | undefined`; matters the moment we index fallback model lists
- `exactOptionalPropertyTypes` — stops `{ timeout: undefined }` satisfying `{ timeout?: number }` when building provider payloads
- `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`
- `module` / `moduleResolution`: `NodeNext`; `target: ES2023`
- ESLint flat config with `@typescript-eslint`; `no-explicit-any` is an **error**

### 5.3 Configuration

Zod schema over `process.env`, parsed **once at boot**, failing fast and reporting *every*
invalid variable rather than the first. Downstream code receives a typed `AppConfig`;
no `process.env` access anywhere else, enforced by lint rule.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | environment mode |
| `PORT` | `4000` | HTTP port |
| `HOST` | `0.0.0.0` | bind address (must be `0.0.0.0` inside Docker) |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_URL` | *required* | Postgres DSN |
| `REDIS_URL` | *required* | Redis DSN |
| `BODY_LIMIT_BYTES` | `1048576` | request size cap |
| `CORS_ORIGINS` | `""` | comma-separated allowlist; empty disables CORS |
| `SHUTDOWN_DRAIN_MS` | `5000` | window where `/ready` returns 503 before closing |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | hard force-exit deadline |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_BASE_URL` | optional | present in `.env.example`; **unused and unvalidated until Phase 3** |

`loadConfig()` is shaped to later merge a YAML config file (spec §7) with env taking
precedence. The YAML loader itself is **not** implemented in Phase 1.

### 5.4 Logging

Pino (Fastify's built-in logger — no new dependency):

- **Redaction configured from the first commit**: `req.headers.authorization`,
  `req.headers["x-api-key"]`, `*.apiKey`, `*.api_key`. Secret safety belongs in base config,
  not in reviewer vigilance.
- `pino-pretty` in development, JSON in production.
- Small `req`/`res` serializers rather than dumping whole Node request objects.

### 5.5 Health & readiness

`GET /health` — liveness. **Zero dependency checks.** 200 while serving, 503 once draining.

```json
{ "status": "ok", "uptimeSeconds": 812, "version": "0.1.0" }
```

`GET /ready` — readiness. 200 only when all required deps respond:

```json
{
  "status": "ready",
  "checks": {
    "redis":    { "status": "up", "latencyMs": 2 },
    "postgres": { "status": "up", "latencyMs": 4 }
  }
}
```

Returns **503** with the same body shape on failure, so a load balancer can parse the reason.
Two details that matter: checks run **in parallel under a hard per-check timeout** (a hung
Postgres must not hang the probe), and results are **cached ~1s** so a load balancer polling
at 10rps doesn't generate 20 database round-trips per second. The shape leaves room for a
`providers` section in Phase 3 without breaking the contract.

### 5.6 Graceful shutdown

```text
SIGTERM / SIGINT
  → state = "draining"        (/ready → 503, /health still 200)
  → wait SHUTDOWN_DRAIN_MS    (load balancer notices, stops routing)
  → fastify.close()           (stop accepting; in-flight requests finish)
  → redis.quit()
  → pool.end()
  → exit 0
  ⏱ SHUTDOWN_TIMEOUT_MS exceeded anywhere → log + exit 1
```

The drain delay is the commonly-missed part: closing the server the instant SIGTERM arrives
means requests already dispatched by the load balancer get connection-refused. Failing
readiness *first*, then closing, is what makes deploys zero-downtime.
`unhandledRejection` / `uncaughtException` log then trigger the same shutdown path rather
than dying silently. Streamed responses are drained before the server closes — see §9.4.

### 5.7 Docker Compose

| Service | Notes |
|---|---|
| `postgres` | `postgres:17-alpine`, named volume, `pg_isready` healthcheck |
| `redis` | `redis:8-alpine`, `redis-cli ping` healthcheck, `--appendonly no` (our usage is counters and caches; AOF costs write throughput for durability we don't need) |
| `gateway` | built from `docker/gateway.Dockerfile`; `depends_on` both with `condition: service_healthy` so it doesn't boot into a connection-refused loop |
| `ollama` | under `profiles: ["ollama"]` — plain `docker compose up` skips it, `--profile ollama` opts in |
| `dashboard` | intentionally absent until Phase 10 |

### 5.8 Testing

`vitest.workspace.ts` defines two projects:

- **unit** — no infrastructure, runs anywhere. Config schema accepts valid env / rejects invalid
  reporting *all* errors; `/health` 200 with fake deps; `/health` 503 while draining; `/ready` 503
  when a fake dep throws; `/ready` per-check timeout fires on a hanging dep; shutdown hooks run in
  registration order and the force-exit timer trips. Uses `fastify.inject()` — no real sockets.
- **integration** — skipped unless `INTEGRATION_TESTS=1`; connects to compose-backed
  Redis/Postgres and asserts real `/ready` returns 200 with both pings resolving.

CI runs typecheck + lint + unit on every push; integration uses GitHub Actions service containers.

### 5.9 Dependencies

**Runtime:** `fastify`, `@fastify/cors`, `zod`, `pg`, `drizzle-orm`, `ioredis`, `pino`

**Dev:** `typescript`, `tsx`, `vitest`, `drizzle-kit`, `eslint`, `typescript-eslint`,
`pino-pretty`, `@types/node`, `@types/pg`

**Deliberately excluded:** orchestration frameworks (D9), provider SDKs (Phase 3, and even then
behind our own interface), OpenTelemetry (D10), `dotenv` (Node 24 has `--env-file`; compose
injects env directly), testcontainers (D3).

### 5.11 Implementation deviations from this plan

Recorded so the plan and the code stay in agreement.

- **`fastify-type-provider-zod` deferred to Phase 4.** Phase 1 has no request body to
  validate — the type provider's entire value is inferring handler types from a body schema.
  Adding it now would mean pinning a zod-major-coupled dependency (v4 of the provider tracks
  zod 3, v5 tracks zod 4) for zero present benefit. Zod is still used for config validation.
  Decision D6 stands; only its arrival date moved.
- **Root `vitest.config.ts` with `test.projects`** instead of `vitest.workspace.ts`.
  Vitest 3.2 deprecated the workspace file; `projects` is the supported form. Same two-project
  split, same `--project unit` / `--project integration` invocation.
- **pnpm installed via `npm install -g pnpm@10`, not corepack.** The bundled corepack (0.28.1)
  fails signature verification against npm's current registry signing keys and cannot download
  any package manager. Root `package.json` still pins `packageManager: pnpm@10.34.5`, and the
  Dockerfile pins the same version, so reproducibility is unaffected.
- **`logController: new LogController({ disableRequestLogging: true })`** rather than the
  top-level `disableRequestLogging` option, which Fastify 5 deprecates and removes in 6.
  Note Fastify's typings and runtime both expect an *instance*, despite the deprecation
  message reading as though it wants a class.

### 5.10 Verification

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm build
pnpm test:unit                         # no Docker required

cp .env.example .env
docker compose up -d --build
docker compose ps                      # postgres + redis healthy

curl -s localhost:4000/health | jq     # 200, status ok
curl -s localhost:4000/ready  | jq     # 200, both deps up with latencies
curl -sD- -o/dev/null localhost:4000/health | grep -i x-request-id

# The real acceptance test for this phase:
docker compose stop redis
curl -s -o/dev/null -w '%{http_code}\n' localhost:4000/ready    # 503
curl -s -o/dev/null -w '%{http_code}\n' localhost:4000/health   # 200 — liveness unaffected
docker compose start redis

docker compose kill -s SIGTERM gateway
docker compose logs gateway | tail -20 # drain → server → redis → pg → exit 0

INTEGRATION_TESTS=1 pnpm test:integration
```

Step 5 (stop Redis) is the acceptance test that matters — it proves the liveness/readiness
split actually works, not merely that two endpoints return JSON.

---

## 6. Phase 2 — Provider abstraction ✅ complete

> Verified 2026-08-01: 68 unit tests pass (25 new), typecheck and lint clean.
> No provider implementations — those are Phase 3.

### 6.1 What exists

```text
packages/core/src/providers.ts        ProviderId, PROVIDER_IDS, isProviderId
apps/gateway/src/providers/
  types.ts       ChatMessage, ChatRequest, ChatResponse, ChatChunk,
                 TokenUsage, FinishReason, ProviderCapabilities,
                 ProviderCallOptions
  provider.ts    LLMProvider
  messages.ts    splitSystemMessages, foldSystemPrompt
  usage.ts       createTokenUsage, addTokenUsage
```

`ProviderId` sits in `core` because the dashboard speaks it too (provider breakdowns,
request rows). The wire contracts stay in the gateway — one consumer, so per D1 they have
not earned a package.

### 6.2 Design decisions

**The internal format is not OpenAI's.** The public API speaks OpenAI, but requests are
normalized into `ChatRequest` before reaching a provider and denormalized on the way out.
Gemini (`contents`/`parts`) and Anthropic (top-level `system`) are not shaped like OpenAI;
passing the OpenAI body straight through would make every adapter re-parse it and re-derive
the same facts, and would leak OpenAI's API evolution through the whole stack.

**`ChatRequest` has no `stream` flag.** Streaming is expressed by calling `stream()` rather
than `chat()`. A boolean that changes a method's return type is a design smell, and it would
force every adapter to branch on something the caller already decided.

**`ProviderCallOptions.signal` is required — a deviation from the spec's interface sketch
(§3).** Spec §10 requires every provider request to be time-bounded. Wrapping the call in
`Promise.race` against a timer only *abandons* the promise: the HTTP request keeps running,
the socket stays open, and the tokens are still generated and billed. An `AbortSignal`
actually cancels, and it is the same mechanism that propagates client disconnect upstream in
Phase 5. Making it required rather than optional means a caller cannot forget.

**`ChatChunk` is a discriminated union** (`start` → `delta`* → `finish`) rather than
OpenAI's flat delta object. The SSE layer in Phase 5 becomes an exhaustive switch that fails
the build if a variant is added and not handled. The `start` variant carries the model that
actually served the request — under fallback the caller cannot predict it, and a streamed
response has nowhere else to report it.

**Usage is `undefined`, never zero, when unknown.** `createTokenUsage` returns `undefined`
unless both counts are present and sane. Defaulting a missing half to zero would hand Phase 9
a confident-looking number that silently understates cost. Spec §16 requires cost estimates to
be honest about what they do not know, and that starts here.
`ProviderCapabilities.usageReporting` tells the observability layer, per call style, whether
to expect a real figure at all.

**System messages are hoisted, including mid-conversation ones.** `splitSystemMessages` joins
multiple system messages with a blank line and lifts them out regardless of position. This
loses a little fidelity against OpenAI, which would honour position. Accepted deliberately:
Anthropic and Gemini cannot express a positioned system turn, and a gateway whose behaviour
changes depending on which provider happened to serve the request is worse than one that is
consistently, slightly simplified.

### 6.3 Deferred deliberately

Tool/function calling, multimodal content parts, and a provider registry. None has a consumer
yet; all are additive to internal types. `FinishReason` omits `tool_calls` rather than
carrying a value that can never be produced.

### 6.4 Testing note

Phase 2 is mostly types, and types prove nothing at runtime. `provider-contract.test.ts`
defines a stub `LLMProvider` **in test scope** — so the "no implementations" boundary holds —
and asserts the contract actually works: chunk ordering, that an abort mid-stream propagates,
and that breaking out of `for await` runs the generator's `finally` (the Phase 5 connection
cleanup guarantee). A `never` assignment in the chunk switch enforces exhaustiveness at
compile time.

---

## 7. Phase 3 — Providers ✅ complete

> Verified 2026-08-01: 186 unit tests pass (118 new), typecheck and lint clean.
> **No test requires a provider API key or network access.**

### 7.1 What exists

```text
apps/gateway/src/providers/
  transport.ts        injectable fetch, HTTP status → LLMErrorCode, Retry-After
  stream-parsers.ts   readLines, parseSSE, parseNdjson
  mock.ts             MockProvider
  openai.ts           OpenAIProvider
  anthropic.ts        AnthropicProvider
  gemini.ts           GeminiProvider
  ollama.ts           OllamaProvider
  registry.ts         createProviderRegistry
```

**Scope note:** the roadmap row above originally read "Mock, OpenAI, Gemini, Ollama",
following spec §27. Anthropic was included because spec §1 lists it as an initial provider
and `architecture.md` already placed it in Phase 3; the marginal cost was one adapter.

### 7.2 Design decisions

**`fetch` is injected into every adapter.** This is what makes the entire suite runnable with
no API keys and no network — tests supply a function returning canned `Response` objects and
the adapter cannot tell the difference. Spec §21 requires a contributor with no provider
accounts to run everything.

**Status→code mapping is centralized in `transport.ts`.** It is the highest-leverage function
in the layer: the router's retry and fallback decisions read `retryable` off the resulting
code. `502/503/504` map to `UNAVAILABLE` (try elsewhere) distinctly from a bare `500`
(`PROVIDER_ERROR`), and `404` maps to `MODEL_NOT_FOUND` because the paths are fixed and we
build them ourselves.

**The line reader is shared, and it buffers across chunk boundaries — including mid-character.**
A network chunk is not a line, and it is not a character either. Parsing chunks independently
works perfectly in testing and starts dropping tokens once responses get long enough to span
chunks; decoding chunks independently mangles any non-ASCII text at random points. Both are
covered by tests that deliberately split a UTF-8 sequence.

**Abort and stream failures are normalized differently.** `normalizeFetchError` handles
connection-time failures; `normalizeStreamError` handles failures once the response has
started, where a `SyntaxError` means the provider sent a malformed event (their bug,
`PROVIDER_ERROR`) rather than being unreachable.

**Compatibility fixes that belong in the gateway, not the client:**
- Anthropic requires `max_tokens`; we default it rather than rejecting an OpenAI-shaped
  request where the field is optional.
- Anthropic and Gemini expect alternating turns; `mergeConsecutiveMessages` merges repeats
  that OpenAI would have accepted. Rejecting input purely because of which provider served it
  would break the compatibility promise.
- OpenAI streams no usage at all unless `stream_options.include_usage` is sent, so we always
  send it — otherwise every streamed request becomes uncosted.
- Gemini's key goes in a header, never the `?key=` query parameter its quickstarts use.

**Provider enablement is derived from credentials.** No `*_ENABLED` flags. Only configured
providers are constructed, so the gateway never advertises a model it cannot serve. The
mock provider is off in production by default.

**`max_completion_tokens`, not `max_tokens`, for OpenAI.** OpenAI rejects `max_tokens`
outright on reasoning models, and the old name never counted input tokens anyway.

### 7.3 MockProvider

Driven per-request by the model name (`mock/rate-limited`, `mock/timeout`, …) so a test
scenario is visible in the request rather than buried in setup, and globally by
`MOCK_LATENCY_MS` / `MOCK_FAILURE_RATE` for soak testing. Its RNG and clock are injected, so
failure-rate tests are deterministic and latency tests do not spend real time.

`mock/invalid` exists specifically to prove Phase 6 does **not** fail over on client errors.

### 7.4 Deferred

Provider health checks (the `providers` section of `/ready`) — Phase 3 gives `/ready` nothing
to report until there is a route exercising providers. Tool calling and multimodal parts
remain unmodelled.

---

## 7b. Phase 4 — `POST /v1/chat/completions` ✅ complete

> Verified 2026-08-01: 229 unit tests pass (40 new), typecheck and lint clean, and every
> path exercised against the running container with `curl`.

### 7b.1 What exists

```text
apps/gateway/src/
  http/schemas/chat-completions.ts   Zod request schema, request/response mappers
  http/routes/chat-completions.ts    the route (translation only)
  routing/model-resolver.ts          spec §8 Level 1 — explicit model resolution
  chat/chat-service.ts               resolve → bound → call
```

Request path: **route → chat service → model resolver → registry → provider.**

### 7b.2 Design decisions

**zod 3 → zod 4.** `fastify-type-provider-zod@7` requires zod ≥4.1.5. Pinning the provider to
its legacy v4 line to stay on zod 3 would have locked the project to a deprecated dependency;
upgrading now, with 189 tests already green to catch regressions, was the cheap moment. The
whole suite passed unchanged.

**Explicit model resolution landed here, not in Phase 6.** The route cannot function without
*some* way to decide that `gpt-4.1-mini` means OpenAI. This is spec §8 Level 1 only —
`provider/model` prefixes plus known model-name prefixes. Aliases, routes and fallback
strategies layer on top in Phase 6 without the route changing.

Unresolvable models are **refused, not guessed at**: guessing sends the request, and the
money, to a provider the caller never asked for. The error names the qualified form
(`ollama/llama3.2`).

Prefixes split on the **first** slash only, so `openai/meta-llama/Llama-3-70B` keeps its
namespaced model name intact for OpenAI-compatible servers.

**Unknown request fields are ignored; four are refused loudly.** Real OpenAI SDKs send `user`,
`seed`, `presence_penalty` and more — rejecting them would break "change only your baseURL"
for clients doing nothing wrong. But `tools`, `response_format`, `n > 1` and `stream:true`
each change what a correct answer looks like, so silently proceeding without them returns
output the caller would reasonably treat as valid. Those get a clear 400.

**Timeouts are enforced here** (spec §10), via `AbortSignal.any([clientDisconnect, timeout])`.
Both actually cancel the upstream HTTP request rather than abandoning a promise — so a caller
who hangs up stops costing money mid-generation. Phase 7 adds retry and backoff around this.

**Routing facts go in headers, not the body.** `x-openllm-provider` and `x-openllm-model`
report who actually served the request; the body stays exactly OpenAI-shaped for strict
clients. Responses serialize *through* the Zod schema, so nothing outside it can leak into a
body whatever a later refactor returns.

**`usage` is omitted when the provider reported none** — a deliberate deviation from OpenAI,
which always sends it. Reporting zeroes would be a lie that understates cost (spec §16).

### 7b.3 Deferred

Tool calling, multimodal parts, `/v1/models`.

---

## 7c. Phase 5 — Streaming (SSE) ✅ complete

> Verified 2026-08-01: 254 unit tests pass, typecheck and lint clean. Against the running
> container: chunks arrive incrementally (~120ms apart, not one buffered blob), content
> reassembles byte-exact, a pre-stream 429 comes back as a real `429 application/json`,
> killing the client mid-stream logs `stream aborted by client` and stops the provider,
> and SIGTERM with a 12s stream in flight drains it to completion and exits 0.

### 7c.1 What exists

```text
apps/gateway/src/http/
  sse.ts             SSEWriter — hijack, headers, backpressure-aware writes
  disconnect.ts      watchForDisconnect — premature-hangup detection
  active-streams.ts  registry of in-flight streams, drained on shutdown
  schemas/chat-completions.ts   toRoleChunk / toContentChunk / toFinishChunk / toUsageChunk
  routes/chat-completions.ts    streaming branch
apps/gateway/src/chat/chat-service.ts   ChatService.stream()
```

### 7c.2 Design decisions

**The first chunk is pulled BEFORE committing to a 200.** This is the pivot of the whole
design. Once a byte of body is written the status code is fixed, so a provider 429 after that
point could only be reported as an event inside a nominally successful response. Every
adapter performs its HTTP request and throws on a non-OK status *before* yielding anything,
so awaiting exactly one chunk converts the common failures — rate limits, auth, unknown
model, timeout — back into ordinary status codes clients already handle. Errors that happen
later are emitted as an SSE error event and the stream closes **without `[DONE]`**, because
`[DONE]` means "completed successfully".

**`reply.hijack()` rather than a Fastify stream reply.** Fastify's reply lifecycle assumes
one buffered payload; it cannot express "200, headers now, body over the next thirty
seconds". Hijacking has consequences that are easy to miss and are handled explicitly:
`reply.header()` no longer applies (correlation headers are written into `writeHead`), and
`onResponse` hooks do not fire (the route logs its own completion line).

**Writes respect backpressure.** `res.write()` returning false means the client is reading
more slowly than the provider generates. Ignoring it queues every chunk in process memory,
so one slow reader on a long completion becomes unbounded heap growth.

**`x-accel-buffering: no` and `cache-control: no-transform`.** nginx buffers proxied
responses by default and a compressing proxy will buffer the whole stream to gzip it — either
turns token-by-token delivery into one lump at the end, in exactly the deployment most people
have.

**Usage only when asked.** `stream_options.include_usage` gates the trailing usage chunk,
matching OpenAI. That chunk has an **empty `choices` array** — clients that index `choices[0]`
crash on anything else.

**Streams are drained before the HTTP server closes.** Registered ahead of the `http-server`
hook, because `app.close()` would otherwise sit blocked on a long completion. In-flight
streams get `SHUTDOWN_STREAM_GRACE_MS` to finish and are then aborted cleanly, rather than the
process being SIGKILLed with sockets open.

### 7c.3 Bug found by verification

The first implementation watched `request.raw`'s `close` event to detect client hangup. That
event fires when the request **body** has been read, not when the connection drops. With
instant mock responses the race was invisible and all unit tests passed; introducing a 120ms
inter-chunk delay made every stream abort after its first chunk and return `INTERNAL_ERROR`.

Fixed by watching the **response** and checking `writableFinished` to distinguish "we finished
writing" from "the socket went away". Extracted into `disconnect.ts` with a regression test,
since `inject()` cannot reproduce the timing. Worth recording: this class of bug is invisible
to in-process tests and only appears over a real socket.

---

## 7d. Phase 6 — Routing ✅ complete

> Verified 2026-08-01: 314 unit tests + 4 integration tests pass, typecheck and lint clean.
> Against the running container with a real `openllm.yaml`: aliases resolve, a 429 on the
> first target falls over to the second (`x-openllm-attempts: 2`), a non-retryable 400 does
> NOT fall over, an exhausted route reports `All 2 providers failed`, and streaming fallback
> swaps providers invisibly — the client gets a clean 200 with the full content.

### 7d.1 What exists

```text
apps/gateway/src/config/file.ts          YAML loading + validation
apps/gateway/src/routing/
  model-resolver.ts   Level 1 — explicit provider/model, known prefixes
  route-table.ts      Level 2/3 — aliases and routes, resolved at boot
  fallback.ts         runWithFallback / streamWithFallback
packages/core/src/errors.ts              + failoverable axis
openllm.example.yaml                     committed template
```

### 7d.2 Design decisions

**`failoverable` is a second axis, separate from `retryable`.** The two questions have
genuinely different answers. Retrying OpenAI for a model it does not have is pointless, but
Anthropic may have an equivalent — `MODEL_NOT_FOUND` is *not retryable* yet *is failoverable*.
Same for `AUTHENTICATION_ERROR`: our OpenAI key will not fix itself on attempt two, but a
Gemini key is a different credential. Collapsing them into one flag forces a choice between
failing requests a configured fallback could have served and burning attempts on errors that
cannot improve. `INVALID_REQUEST` and `INTERNAL_ERROR` are neither — they fail identically
everywhere, and replaying one across four providers means four charges for four identical 400s.

Falling over on `AUTHENTICATION_ERROR` does mask a misconfiguration, so it logs at **warn**
with explicit "fix the credential" wording. Availability wins for an explicitly configured
fallback route; the log is what keeps the problem visible.

**`models:` and `routes:` are unified.** They are two spellings of one idea — a name mapped to
an ordered list — and keeping them as parallel mechanisms raises "which wins when a name is in
both?" with no good answer. A name defined twice is rejected at startup instead.

**Route targets resolve at boot.** A model the gateway cannot route to any provider stops
startup with a precise message, rather than 404ing the first time someone uses that alias. A
fallback route exists for when things are *already* going wrong; finding out it was
misconfigured during an incident is the worst possible timing. The honest limit: this checks
that a provider can be *determined*, not that the model exists — `gemini-2.5-flsah` passes the
`gemini-` prefix and 404s at Google. Verifying existence would make startup depend on every
provider being reachable, a worse trade.

**A route name may not shadow a real model.** Naming a route `gpt-4.1-mini` would silently
send those requests elsewhere, and nothing in the request would reveal it.

**Credentials never appear in YAML.** Config files get committed; keys in them get committed
too. The schema is `.strict()`, so `providers.openai.apiKey` is a validation error rather than
a silently ignored field. `enabled` can only turn OFF what the environment already made
possible — "enabled but unable to authenticate" is not a state worth expressing.

**Streaming fallback works because of Phase 5.** The route pulls one chunk before committing
to a 200, and adapters throw on a non-OK status before yielding — so a rate-limited first
provider is swapped with the client none the wiser. Once a chunk *has* been delivered, fallback
stops: those tokens are on the wire, and restarting elsewhere would produce a response that
contradicts itself mid-sentence.

**`ChatStream` no longer carries `provider`.** Under fallback the serving provider is unknown
until an attempt succeeds, so it is read from the `start` chunk — which is exactly what that
chunk was added for in Phase 2.

### 7d.3 Not implemented

Round-robin, least-latency, lowest-cost and reliability-weighted strategies (spec §8 names them
as future work). `RouteStrategy` is a union of one, so adding a case makes
`noFallthroughCasesInSwitch` flag every site that needs updating.

---

## 7e. Phase 7 — Reliability ✅ complete

> Verified 2026-08-01: 343 unit tests + 4 integration tests pass, typecheck and lint clean.
> Against the running container: `mock/server-error` makes 3 attempts with jittered backoff
> (143ms + 489ms, total 0.66s); `mock/invalid` returns in 6ms with no backoff at all;
> `mock/rate-limited` honours the provider's 1000ms `Retry-After` exactly (total 2.02s);
> and a retry-then-fallback route reports `x-openllm-attempts: 4`.

### 7e.1 What exists

```text
apps/gateway/src/infra/sleep.ts        abortable delay (shared with the mock provider)
apps/gateway/src/routing/
  deadline.ts   request-wide budget
  retry.ts      backoff schedule, jitter, Retry-After, withRetry
```

### 7e.2 Design decisions

**Two timeouts, not one.** `PROVIDER_TIMEOUT_MS` bounds a single call;
`REQUEST_TIMEOUT_MS` bounds the whole operation. Conflating them means reliability features
multiply latency instead of improving it — three targets at three attempts each is nine calls
plus eight waits, several minutes for a caller who gave up after ten seconds. The request
budget is what makes retry and fallback safe to enable by default.

**The per-attempt signal is rebuilt each attempt.** A single shared `AbortSignal.timeout`
would be consumed by the first try and abort every retry after it. Each attempt also gets
`min(providerTimeout, remainingBudget)`, so no attempt can outlive the request.

**Retry nests inside fallback.**

```
for each target:        <- fallback  (a different provider)
  for each attempt:     <- retry     (the same provider)
    one provider call   <- PROVIDER_TIMEOUT_MS
...all bounded by       <- REQUEST_TIMEOUT_MS
```

Retries are exhausted on a target before moving on, so a single-target route still recovers
from a blip and a multi-target route does not skip past a provider that was one retry from
succeeding. The inner loop reads `retryable`, the outer reads `failoverable` — the two axes
from Phase 6 acting independently. `MODEL_NOT_FOUND` demonstrates both at once: no retry, but
immediate failover.

**Jitter is on by default.** Equal jitter (half fixed, half random) keeps spec §9's
250/500/1000 schedule as the expected value while breaking client synchronisation. Without it,
every client that hit the same provider outage retries at the same instant and re-creates the
spike — and a gateway sits in front of many callers, so it would be amplifying the herd rather
than absorbing it. Full jitter was rejected: it sometimes retries almost immediately, which is
worse when a provider is genuinely overloaded.

**A provider's `Retry-After` beats our guess.** Already captured into `details.retryAfterMs`
by the Phase 3 transport; now consumed. The provider knows its real limit, our exponential
curve is a model of it. Log lines carry `honouredRetryAfter` so the two are distinguishable.

**Retries stop early when the budget cannot fit them.** Sleeping only to then abandon the
request wastes the caller's time and ours; giving up immediately leaves what remains for a
different provider. Verified: with a 100ms budget, a flaky first target fails over instantly
rather than backing off.

**`streamWithFallback` now takes an already-started stream.** Its `start` callback opens the
stream *and* pulls the first chunk, so the caller can layer retry inside it and fallback still
sees exactly one outcome per target. Retry stays out of the fallback file entirely.

### 7e.3 Rejected

Smuggling per-target call counts through `LLMError.details` so fallback could report them.
Fallback now reports only what it observes; the total provider-call count is owned by
`ChatService` and surfaced as `x-openllm-attempts`, and per-target retry detail lives in the
warn logs — which is where an operator would look anyway.

---

## 7f. Phase 7.5 — API key authentication ✅ complete

> Verified 2026-08-01: 382 unit + 13 integration tests pass, typecheck and lint clean.
> Against a live auth-enforced container: probes public without a key, chat 401s without one,
> a minted key works, revocation takes effect on the very next request, the raw key appears
> in **zero** log lines, and the admin secret and user keys cannot substitute for each other.

### 7f.1 What exists

```text
apps/gateway/src/auth/
  api-key.ts             generate, hash, parse, constant-time compare
  api-key-repository.ts  lookup by hash, create, list, revoke, throttled touch
apps/gateway/src/db/
  schema.ts              api_keys
  migrate.ts             boot migrator under a Postgres advisory lock
  ../../drizzle/0000_api_keys.sql
apps/gateway/src/http/plugins/authentication.ts
apps/gateway/src/http/routes/admin-keys.ts
apps/gateway/src/cli/create-key.ts
```

### 7f.2 Design decisions

**SHA-256, not bcrypt/argon2.** The counter-intuitive one, and correct here for two reasons.
*Entropy*: password hashing is slow to make brute-forcing low-entropy human secrets expensive;
these are 256 bits of CSPRNG output, so there is no dictionary and slowness buys nothing.
*Lookup*: bcrypt and argon2 salt per record, so their output cannot be an index key —
authenticating would mean loading every row and verifying against each, which at ~100ms per
verify is a throughput cap of single-digit requests per second, not a performance detail.
Rainbow tables, the usual objection to unsalted hashing, are built over plausible human inputs;
there is no table of random 256-bit strings.

**No cache on the auth path.** One indexed lookup is ~1ms against provider calls measured in
hundreds. Skipping the cache buys *immediate revocation*, which is worth more than the
millisecond. Add one when measurement says to, not before.

**Two separate credentials.** User keys are database-backed hashes reaching `/v1`; the admin
secret is environment-only and reaches `/v1/admin`. A database compromise therefore yields
hashes an attacker cannot reverse **and** no way to mint working credentials. Verified: neither
credential works on the other's routes.

**Probes are never authenticated.** An orchestrator cannot hold a key. Auth on `/health` means
a misconfigured secret makes Kubernetes kill every pod — an auth problem escalated into a total
outage.

**Auth registers before the routes**, so opting *out* is the explicit act. A route that forgot
to opt in would be an open door.

**Unknown and revoked keys return an identical message.** Distinguishing them confirms to an
attacker that a value was once valid. The distinction lives in the logs.

**`AUTH_REQUIRED` defaults on in production, off elsewhere** — the same shape as the mock
provider, and for the same reason. A **warning is logged whenever it is off**; that state must
never be quiet. The compose file disables it explicitly, with a comment saying to drop the line
for a real deployment.

**Revocation is a status change, not a delete.** Phase 9's request history references these
rows; "who made this call" must survive the key being turned off.

**Migrations run at boot, under a Postgres advisory lock.** The alternative is a deploy that
starts, serves 500s against a missing table, and waits for someone to remember the manual step.
The lock serializes concurrent replicas. `SKIP_MIGRATIONS=true` for deployments that run them
separately.

### 7f.3 Beyond the spec's table

Spec §14 lists `id, name, key_hash, status, created_at`. Added:

- **`key_prefix`** — a key you cannot identify is a key you cannot safely revoke. Without it a
  dashboard shows only opaque UUIDs and an operator has no way to match a row to the key in
  their config. Every developer platform does this.
- **`last_used_at`** — answers "which keys can I safely revoke?", otherwise unanswerable, which
  leaves dead credentials live forever. Written **fire-and-forget and throttled to once per
  minute per key**: without the throttle, a read-only auth check becomes a database write on the
  hottest path in the system, for a column whose useful resolution is "roughly when".
- **`revoked_at`** — an audit trail that a boolean status cannot provide.

---

## 7g. Phase 8 — Redis ✅ complete

> Verified 2026-08-01: 416 unit + 26 integration tests pass, typecheck and lint clean.
> Live: 25 requests against a 20/min limit gave exactly 20 allowed / 5 limited with correct
> headers; 20 concurrent requests against a bucket of 5 gave exactly 5 successes; stopping
> Redis kept chat at HTTP 200 with `x-openllm-ratelimit-degraded: true` while `/ready` went
> 503 and `/health` stayed 200; the cache hit on a repeat and missed on a changed temperature;
> the circuit opened at the threshold with state visible in Redis (`ttl: 29`).

### 7g.1 What exists

```text
apps/gateway/src/redis/
  keys.ts             namespaced, versioned key strategy
  rate-limiter.ts     token bucket in Lua
  response-cache.ts   exact-match cache (opt-in)
  circuit-breaker.ts  shared provider health
apps/gateway/src/http/plugins/rate-limit.ts
```

### 7g.2 Design decisions

**Token bucket, not fixed window.** Spec §12 wants requests/minute now and tokens/minute later;
a bucket gives both because cost is a parameter — requests/minute is cost 1, tokens/minute is
cost N, same code. A fixed window also permits a caller to send a full window at `11:59:59` and
another at `12:00:00`, so "60/minute" allows 120 in a second.

**Lua, because read-modify-write is a race.** Two concurrent requests both read "1 token left",
both proceed, limit breached — precisely what §12 says to avoid. Proven with a concurrency test
rather than asserted: 20 simultaneous requests against a bucket of 5 yield exactly 5 successes,
including across two limiter instances sharing one Redis.

**`redis.call('TIME')`, not a gateway timestamp.** With several replicas, clock skew makes the
bucket refill inconsistently — an instance running fast grants free tokens. There is exactly one
clock they all agree on.

**Everything fails in the direction that keeps traffic flowing.** Rate limiter allows, cache
misses, breaker closes. These are cost and latency optimisations; none is worth being the reason
the gateway is down. But the limiter's degraded state is surfaced in a response header *and* a
warning log — silently not limiting is how an unexpected bill arrives.

**The cache is off by default.** Enabling it stores completion text in Redis for the TTL, and
privacy-first is the default (§14, §26). It also makes repeated calls deterministic at
`temperature > 0` — usually desirable, but a semantic change the operator should choose. Keys
are hashes so prompts are not recoverable from them; values are readable by anyone with Redis
access, and the docs say so plainly rather than burying it.

**The breaker never opens every path.** If all targets look unhealthy the router tries anyway:
a guaranteed failure is worse than a probably-failing attempt, and it is the only way the
circuit closes again. Only failoverable errors count, so one malformed client request cannot
open circuits on every provider.

**Rate limiting registers after authentication**, so the bucket is keyed by the authenticated
key rather than an IP the caller can change. Probes are exempt for the same reason they skip
auth.

### 7g.3 Deferred

Tokens/minute limiting — the bucket already accepts a cost, but a token count is only known
*after* a response, so it needs the usage data Phase 9 persists. Per-key limit overrides need a
column on `api_keys`; noted, not built.

---

## 7h. Phase 9 — Observability ✅ complete

> Verified 2026-08-01: 451 unit + 33 integration tests pass, typecheck and lint clean.
> Live against Postgres: four request shapes (fallback success, streamed, client error,
> unknown model) each persisted with the right provider, call count, tokens and cost;
> a full-text search of the table for prompt content returned **0**; SIGTERM with five
> records buffered flushed all five (4 → 9 rows).

### 7h.1 What exists

```text
apps/gateway/src/observability/
  pricing.ts            ModelPricing, lookup, estimateCost
  request-recorder.ts   buffered, batched, bounded writer
apps/gateway/src/http/plugins/observation.ts
apps/gateway/src/db/schema.ts        + requests
apps/gateway/drizzle/0001_requests.sql
```

### 7h.2 Design decisions

**Writes are buffered and batched off the request path.** An awaited INSERT per request adds a
round-trip to every call and puts Postgres in the critical path of an API whose whole job is
proxying somebody else's: a slow Postgres would make the gateway slow, a down Postgres would
make it down — to save data nobody is reading right now. A write failure loses metrics, which
is the correct thing to lose.

**The buffer is bounded and drops the oldest.** Unbounded, a Postgres outage grows it until the
process OOMs — a recoverable dependency failure escalated into a hard crash that also loses
everything already buffered. Dropping is visible: counted, logged (throttled, so a database
problem does not also become a log flood), and reported at shutdown.

**Recording is an `onResponse` hook, not route code**, so success, validation failure, rate
limit and provider error are all covered uniformly. A route that returned early would otherwise
be a silently unrecorded request. Streaming records explicitly because `reply.hijack()` skips
the response lifecycle; a `recorded` flag makes it idempotent.

**No prompt or completion column exists.** Not unpopulated — absent, in both the type and the
table. A nullable `prompt` column is one somebody eventually fills in "just for debugging". An
integration test asserts no content-shaped column exists so the guarantee survives a future
migration, and a unit test asserts prompt text never reaches the record even when the mock
echoes it straight back.

**Unknown cost is NULL, never zero.** Zero is a claim ("free"); NULL is the truth ("unknown").
Zero-filling makes every aggregate understate the bill in a way that looks like good news, and
`sum()` skips NULLs so totals stay honest. Same rule as token usage, applied consistently.

**Cost is `NUMERIC(20,10)`, not double precision.** A request costs a fraction of a cent;
summing millions of floats accumulates error precisely at the monthly total.

**Pricing is data, not code** (spec §16). It lives in `openllm.yaml` so a price correction
needs no redeploy, matches by exact key then longest prefix so dated model snapshots do not each
need an entry, and operator entries win outright rather than deep-merging — a half-overridden
price is worse than either.

**Costs are labelled estimates everywhere**, because provider billing has cached-input
discounts, batch rates, reasoning-token rules and negotiated pricing that this model cannot see.
Displaying them as "cost" would be lying by a small, unauditable percentage.

**`api_key_id` is not a foreign key.** Request history must outlive the key: deleting a key row
should not silently erase the record of what it spent.

### 7h.3 Scope call: no `providers` table

Spec §14 lists one. It is not built, deliberately — provider configuration lives in the
environment (correctly, since it holds credentials), provider health lives in Redis, and
per-provider statistics are derivable from `requests` with a `group by`. A `providers` table
would either duplicate configuration or store a denormalised aggregate that can go stale. If a
concrete need appears — per-provider quotas, say — it can be added then.

### 7h.4 Unblocked

Tokens/minute rate limiting, deferred from Phase 8, now has its input: the bucket already
accepts a cost, and token counts are recorded per request.

---

## 7i. Phase 10 — Dashboard ✅ complete

> Verified 2026-08-01: 466 unit + 33 integration tests pass, typecheck and lint clean.
> Live: `docker compose up` brings up four services; the SPA and its assets are served
> (248KB bundle, valid JS, stylesheet 200); stats resolve through the nginx proxy with real
> data; unauthenticated and wrong-credential requests are refused; and the dashboard
> credential is refused on key management.

### 7i.1 What exists

```text
apps/gateway/src/observability/request-repository.ts   read-only aggregate queries
apps/gateway/src/http/routes/admin-stats.ts
apps/dashboard/                    React + Vite + Tailwind + TanStack Query
docker/dashboard.Dockerfile        nginx serving the SPA and proxying /v1
docker/dashboard-nginx.conf
```

### 7i.2 Design decisions

**A separate, read-only `DASHBOARD_API_KEY`.** The dashboard is a browser app, and whatever
credential it holds is one XSS away from being someone else's — so it must not be one that can
mint API keys. The gateway accepts it only on `/v1/admin/stats/*`, `/v1/admin/requests*` and
`/v1/admin/traces/*`; key creation and revocation still require `ADMIN_API_KEY`. Verified in
both directions. `ADMIN_API_KEY` also works on the read-only routes, for curl and scripts.

**nginx proxies `/v1`, so the browser is same-origin with the API.** That is why no CORS
configuration exists anywhere in this project, and why the gateway never needs to know the
dashboard's address. The Vite dev server proxies identically, so development matches production.

**Aggregation runs in Postgres, not the browser.** A dashboard that loads a month of rows to sum
them client-side stops working at exactly the traffic level where the numbers become interesting.

**p95 latency alongside the average.** An average hides the tail, and the tail is what people
mean when they say the gateway feels slow; a dashboard showing only a mean can look healthy
through an incident.

**Null is never rendered as zero.** A request whose model has no pricing shows `—`, and the cost
tile reports how many requests were unpriced. The distinction has been preserved from the
provider adapters through the database — collapsing it in the last step before a human reads it
would waste the effort and present "we don't know" as "it was free".

**No business logic in components** (spec §22). Fetching, URL building and response shaping live
in `src/api/`; formatting rules live in `format.ts`, stated once.

**Dense tables, no charts** (spec §18: useful information over polish). The questions this
answers — is it working, what is it costing, what happened to that request — are not better
served by a graph than by a number.

**No prompts or completions shown.** Not filtered out: never stored, so there is nothing to omit.

### 7i.3 Bug found by live data

A failed request recorded `provider: null`, so provider failures landed in the `unrouted`
bucket — the opposite of what an operator needs, since "which provider failed?" is the main
question a dashboard answers. The success path sets the provider after `complete()` returns, and
a failure never reaches it. Fixed by having the error handler fill `provider`/`model` from the
normalized `LLMError`, which already carries them. Two regression tests: a provider error is
attributed to that provider, and a genuinely unroutable model still records `null` rather than
an invented one.

### 7i.4 Not verified

The React UI has **not been rendered in a browser** here — no browser was available. What was
verified: the SPA and its hashed assets are served, the bundle is valid JavaScript, the stylesheet
loads, and every API endpoint the UI consumes returns the expected shape with real data.

---

## 7j. Phase 11 — Test hardening & documentation ✅ complete

> Verified 2026-08-01: 476 unit + 51 integration tests pass, typecheck and lint clean.
> Unit coverage 84.96% statements / 88.63% branches / 92.45% functions. The integration suite
> runs twice in CI and passes both times.

### 7j.1 What this phase added

**An end-to-end suite over a real socket** (`test/integration/e2e.test.ts`). Everything before
this used `app.inject()`, which skips the HTTP stack entirely — no sockets, no keep-alive, no
incremental flushing, no client that can hang up. That gap was not theoretical: the Phase 5
disconnect bug passed 251 injected tests and only appeared once bytes crossed a connection. The
new suite starts the server on a real port, drives it with `fetch`, and asserts what only a real
transport can show — chunks arriving spread over time rather than in one blob, a client aborting
mid-stream, and the full loop from request to persisted row to dashboard statistics.

**The CLI as a spawned process** (`test/integration/cli.test.ts`). It is the bootstrap path and
had no in-process entry point, so the honest test is the one an operator performs: run it, read
stdout. Covers the "only the key on stdout" contract that `KEY=$(pnpm -s key:create ci)` relies
on.

**Logger redaction tests.** A coverage pass found `logger.ts` at 0%, despite "secrets are never
logged" being claimed in the README, the architecture doc and this plan. It is now asserted
against real output — including that credential fields are *removed* rather than replaced with a
placeholder, since a placeholder still confirms the field existed. `createLogger` gained an
optional destination purely as a test seam.

**Coverage reporting** (`pnpm test:coverage`), with composition roots excluded — `index.ts` is
wiring whose only meaningful test is booting the real process, which the compose smoke test does.

**CI covering the whole matrix**: typecheck, lint, unit + coverage, dashboard typecheck and
build, integration (twice), and a compose smoke test that now also asserts the quickstart request
works with no API keys configured, streaming terminates with `[DONE]`, the dashboard serves and
proxies, requests still flow with Redis down, and SIGTERM exits 0.

### 7j.2 Bug found: integration tests were stomping on each other

The new E2E suite failed three tests with 401s — but passed when run alone. Cause: several
integration suites issued blanket `delete from api_keys` / `delete from requests`, so one suite
deleted another's fixtures mid-run.

Worse than flakiness: those statements would have destroyed real data if anyone pointed
`DATABASE_URL` at a database that mattered.

Every integration suite now prefixes the rows it creates and deletes only those, and the suites
that assert exact counts filter their selects. CI runs the integration job twice so the scoping
is proven rather than assumed.

### 7j.3 Documentation audit

Checked mechanically rather than by reading:

- **Every environment variable in `env.ts` is documented, and every documented variable exists.**
  No drift after eleven phases.
- Every `pnpm` command the README claims exists in `package.json`.
- The mock-behaviour table was missing `mock/auth-error` and `mock/model-not-found`; added.
- The endpoints table omitted the admin and stats routes; added.
- No test references anything resembling a real provider credential.

Added `CONTRIBUTING.md` and the Apache-2.0 `LICENSE` the README already claimed, and set the
license field on all four packages (the root still carried `ISC` from the original stub).

### 7j.4 Known gaps, stated rather than hidden

- **The React UI has never been rendered in a browser here.** Its API contract is covered; its
  visual behaviour is not.
- `sse.ts` backpressure (the `drain` path) is not directly tested — it needs a slow consumer at
  the socket level.
- No load or soak testing. The rate limiter's atomicity is proven under concurrency, but nothing
  characterises the gateway's behaviour at sustained throughput.
- Coverage is measured on unit tests only; the integration suite raises the real figure but is
  not merged into the report.

---

## 8. Engineering standards

Enforced in review; violations block a phase from closing.

- TypeScript strict mode; **no `any`** unless genuinely unavoidable and commented
- Explicit types on all public interfaces
- Small functions; dependency injection where it aids testability
- Clear error classes; a single normalized internal error model
- Centralized configuration and logging
- **No provider-specific logic in routes**
- **No database queries inside HTTP handlers**
- **No business logic inside React components**
- All external input validated with Zod
- Graceful shutdown and explicit connection cleanup
- Structured logs only — no ad-hoc `console.log`
- Never log API keys, `Authorization` headers, or provider secrets
- Prompt/completion logging **disabled by default**
- No new dependency without a stated reason
- Prefer boring and reliable over clever

---

## 9. Working agreement

After **each** phase, before moving on:

1. Explain what was built
2. Show the relevant architecture
3. List files created/modified
4. Explain important design decisions
5. Run tests
6. Verify the implementation
7. **Stop and wait for approval**

Never generate hundreds of files silently. Never skip tests. Never start the next phase while
the current one is broken. If a design decision looks wrong, say so *before* implementing it.

---

## 10. Security & privacy commitments

These are promises made in the README and must hold at every phase:

- API keys hashed at rest; raw keys shown exactly once at creation, never stored
- Provider API keys never exposed through the API or dashboard
- Prompt and completion content never persisted by default
- Request size limits, provider timeouts, and rate limiting enforced
- CORS explicitly configured, not wildcard-by-default
- No secrets in logs — enforced via pino redaction, not discipline
