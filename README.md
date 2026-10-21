# retrysafe-backend

Server-side and runtime pieces of [retrysafe](https://github.com/sammy440/retrysafe):

| Package | What it is |
|---|---|
| [`guard/`](guard) | `@retrysafe/guard`: a runtime library for exactly-once webhook and queue processing (Postgres/Prisma transactional claims, Redis leases, provider event keys). Published to npm. |
| [`api/`](api) | `@retrysafe/api`: the HTTP API behind the playground on the retrysafe website. Static analysis only. |

```sh
corepack pnpm install     # or: npx pnpm@9.15.0 install
pnpm test                 # both packages
pnpm dev                  # API on http://localhost:8787
```

The API depends on `@retrysafe/core` from the retrysafe monorepo through a `link:` to `../../retrySafe/packages/core`,
so keep both checkouts side by side (`~/…/retrySafe` and `~/…/retrysafe-backend`).

## API

| Method | Path | |
|---|---|---|
| `GET` | `/health` | `{ ok, active }` |
| `GET` | `/v1/rules` | Rule docs: id, severity, summary, why, safePattern |
| `POST` | `/v1/analyze` | `{ files: { "path.ts": "source", ... }, options?: { minConfidence, maxCallDepth, serverActions } }` → `{ result, durationMs }` |

`result` is retrysafe's `AnalysisResult`: handlers, their effects, guards, and checks (the effect map), and findings with failing sequences and fixes.
Submit `tsconfig.json` to use path aliases, and `*.prisma` / `*.sql` files to enable schema-aware checks.

Errors are `{ error: { code, message, details? } }` with codes `invalid_json`, `invalid_request`, `payload_too_large`,
`rate_limited` (429, `Retry-After`), `busy` (503), `timeout` (504), and `analysis_failed`.

### Safety

- Submitted code is **parsed and type-checked, never executed**. `retrysafe verify`, which does run code, is CLI-only.
- Files live in an in-memory file system. Nothing is written to disk or stored after the response.
- Each analysis runs in its own worker thread with a memory cap and a wall-clock timeout. At most `MAX_CONCURRENT` run at once.
- Paths must be relative, without `..`, with a source, `.prisma`, `.sql`, or `.json` extension. File count and sizes are capped.
- Per-client rate limit (in memory; use a shared store if you run several instances).
- CORS is restricted to `ALLOWED_ORIGINS`.

### Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `8787` | |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Comma-separated; `*` allows any |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs (behind a load balancer) |
| `MAX_FILES` / `MAX_FILE_BYTES` / `MAX_TOTAL_BYTES` | `25` / `100000` / `400000` | |
| `ANALYSIS_TIMEOUT_MS` | `15000` | |
| `MAX_CONCURRENT` | `4` | |
| `RATE_PER_MINUTE` | `30` | |

### Deploying

```sh
pnpm --filter @retrysafe/api build    # bundles @retrysafe/core into api/dist
docker build -t retrysafe-api api     # see api/Dockerfile
docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://your-site.example -e TRUST_PROXY=true retrysafe-api
```
