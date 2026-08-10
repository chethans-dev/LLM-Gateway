# Contributing

Thanks for looking. This is infrastructure, so the bar is "boring and correct" rather than
clever — the notes below are what that means in practice.

## Before anything else: read the plan

[`docs/PLAN.md`](docs/PLAN.md) is the source of truth for scope, sequencing and the
architectural decisions that are considered settled. If code and that document disagree, one of
them is wrong and the disagreement gets resolved there first.

The decisions marked D1–D11 are not up for casual revision. They can absolutely be changed —
but the change belongs in that table, with a reason, in the same pull request.

## Getting set up

```bash
corepack enable pnpm            # or: npm install -g pnpm
pnpm install
docker compose up -d postgres redis
cp .env.example .env
pnpm dev                        # gateway on :4000
```

Node 24 (see `.nvmrc`) and pnpm 10.

## The checks

```bash
pnpm typecheck          # sources and tests, strict mode
pnpm lint
pnpm test               # unit — no Docker, no network, no API keys
pnpm test:coverage

docker compose up -d postgres redis
INTEGRATION_TESTS=1 pnpm test:integration
```

All of these run in CI. The integration suite additionally covers the real datastores, the
migrator, the CLI as a spawned process, and an end-to-end suite that drives the gateway over a
real socket.

## Testing rules that are not negotiable

**No test may require a provider API key, or network access.** Every adapter takes its `fetch`
by injection; the mock provider covers rate limits, outages, timeouts and streaming on demand.
Somebody with no OpenAI, Google or Anthropic account must be able to run everything. Waiting for
a real provider to rate-limit you is not a test strategy, and paying for tokens to assert a 429
is worse.

**Integration tests share one database, so scope your rows.** Prefix anything you insert and
delete only what you inserted. A blanket `delete from …` makes suites stomp on each other — and
would destroy real data if someone pointed `DATABASE_URL` somewhere that mattered. The
integration job runs the suite twice for exactly this reason.

**Prefer a test that would have caught the bug.** Several bugs in this project's history passed
hundreds of in-process tests and only appeared over a real socket. If a change touches the HTTP
layer, streaming, or shutdown, ask whether `inject()` can actually observe the failure mode.

## Code

The full list is in [`docs/PLAN.md` §8](docs/PLAN.md). The ones that come up most:

- TypeScript strict. `any` needs a comment explaining why it is unavoidable.
- `process.env` is read in `src/config` and nowhere else — an ESLint rule enforces it.
- No provider-specific logic in routes; no database queries in HTTP handlers; no business logic
  in React components.
- Structured logs only. Never log an API key, an `Authorization` header, or a provider secret —
  and note that the logger's redaction is tested, so if you add a credential-shaped field, add
  it to the redaction paths and to `logger.test.ts`.
- Every external input is validated with Zod.
- No new dependency without a stated reason in the pull request.

### Comments

Explain **why**, not what. The valuable comment is the one that stops the next person
"simplifying" a decision that looks arbitrary — why the rate limiter fails open, why cost is
`NUMERIC`, why unknown usage is `undefined` rather than `0`.

## Two invariants to be careful around

**Prompts and completions are never persisted.** The `requests` table has no column for them,
and a test asserts that no content-shaped column exists. If you think you need one, that is a
design discussion, not a migration.

**API keys are stored only as hashes**, and the raw key is returned exactly once at creation.
Nothing may add an endpoint that can print it again.

## Adding a provider

1. Implement `LLMProvider` in `src/providers/`.
2. Translate every failure into an `LLMError` with a normalized code — the router's retry and
   fallback decisions read `retryable` and `failoverable`, never a provider's status codes or
   message text.
3. Honour `options.signal`.
4. Add the id to `PROVIDER_IDS` in `packages/core`.
5. Register it in `createProviderRegistry`, enabled by the presence of its credential.
6. Write adapter tests with an injected `fetch` — request translation, response mapping, error
   mapping, and streaming.

## Pull requests

Say what changed and why. If you made a judgement call, say what you rejected and what it cost.
If a decision in `docs/PLAN.md` no longer holds, update it in the same pull request.

Green CI is necessary, not sufficient — but a red build will not be reviewed.
