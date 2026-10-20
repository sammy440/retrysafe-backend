# @retrysafe/guard

Run each webhook or queue event's work once, even though providers deliver it more than once.
Companion runtime library to [retrysafe](https://github.com/sammy440/retrysafe), the static analyzer
that finds handlers needing it. retrysafe recognizes these guards automatically.

```sh
npm install @retrysafe/guard
```

No runtime dependencies. Bring your own `pg`, Prisma, or Redis client.

## Pick a guard

| Your handler's work | Use | Why |
|---|---|---|
| Database writes (Postgres) | `postgresGuard(pool)` | The claim and your writes commit in one transaction: no duplicates, and a crash rolls both back, so nothing is lost |
| Database writes (Prisma) | `prismaGuard(prisma)` | Same, inside `prisma.$transaction` |
| External calls (email, payment API, Slack) | `redisGuard(redis)` | A short lease stops concurrent duplicates; a failure releases it; a crash lets it expire |
| Both | `postgresGuard` / `prismaGuard`, plus the provider's idempotency key on each external call | A database cannot roll back an email |

Every guard has the same shape:

```ts
const result = await guard.run(key, async (tx) => { /* the work */ });
// { status: "processed", value } | { status: "duplicate" } | { status: "in-progress" }
```

## Postgres

Run [sql/retrysafe_processed_events.sql](sql/retrysafe_processed_events.sql) in a migration
(or `processedEventsTableSql()`), then:

```ts
import { Pool } from "pg";
import { eventKey, postgresGuard } from "@retrysafe/guard";

const pool = new Pool();
const guard = postgresGuard(pool);

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], secret);
  const session = event.data.object;

  await guard.run(eventKey.stripe(event), async (client) => {
    // Write through `client`: these commit together with the claim.
    await client.query("INSERT INTO orders (stripe_session, email) VALUES ($1, $2)", [session.id, session.email]);
  });

  res.sendStatus(200); // processed or duplicate: either way the provider can stop retrying
});
```

How it behaves:

- **Retry after success:** the claim insert conflicts, the transaction rolls back, and the work does not run.
- **Two copies at once:** Postgres makes the second insert wait for the first transaction. It then
  conflicts if the first committed, or proceeds if the first rolled back.
- **Crash or error mid-work:** the claim rolls back with the writes, so the retry processes the event.

## Prisma

```prisma
model RetrysafeProcessedEvent {
  key         String   @id
  processedAt DateTime @default(now()) @map("processed_at")
  @@map("retrysafe_processed_events")
}
```

```ts
import { eventKey, prismaGuard } from "@retrysafe/guard";

const guard = prismaGuard(prisma); // { provider: "mysql" | "sqlite" } for other datasources

await guard.run(eventKey.stripe(event), async (tx) => {
  await tx.order.create({ data: { stripeSessionId: session.id } });
  await tx.wallet.update({ where: { userId }, data: { balance: { increment: amount } } });
});
```

## Redis (external effects)

```ts
import Redis from "ioredis";
import { eventKey, redisGuard } from "@retrysafe/guard";

const guard = redisGuard(new Redis(), { leaseSeconds: 120, ttlSeconds: 7 * 24 * 3600 });

const result = await guard.run(eventKey.github(req.headers), async () => {
  await octokit.issues.createComment({ owner, repo, issue_number, body: "Thanks!" });
});
if (result.status === "in-progress") return res.sendStatus(409); // retryable: the provider tries again later
res.sendStatus(200);
```

- `SET key pending NX EX leaseSeconds` claims the event.
- When the work succeeds, the key becomes `done` for `ttlSeconds`. Keep that longer than the
  provider's retry window (Stripe retries for 3 days).
- When the work throws, the claim is deleted, so the retry runs.
- If the process dies, `pending` expires after `leaseSeconds` and a later retry runs.

Works with ioredis, node-redis v4+, and @upstash/redis. The flavor is detected automatically; pass
`{ client: "ioredis" | "node-redis" | "upstash" }` for wrappers and mocks.

Redis cannot commit together with the remote API. If the call succeeds and the process dies before
`done` is written, the next retry repeats it. Pass the provider's idempotency key as well
(Stripe `idempotencyKey`, Resend `idempotencyKey`, SQS FIFO `MessageDeduplicationId`).

## Event keys

Keys must be identical for every delivery of one event and different between events.
`eventKey` encodes the right field per provider and throws `MissingEventIdError` rather than guess:

| Helper | Key | Notes |
|---|---|---|
| `eventKey.stripe(event)` | `event.id` | Not `event.data.object.id`, which is shared by every event about that object |
| `eventKey.github(headers)` | `X-GitHub-Delivery` | |
| `eventKey.shopify(headers)` | `X-Shopify-Webhook-Id` | Not `X-Shopify-Event-Id`, which is shared across subscriptions ([docs](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)) |
| `eventKey.svix(headers)` | `svix-id` / `webhook-id` | Clerk, Resend, and other Svix/Standard Webhooks senders |
| `eventKey.paystack(body)` | `event` + `data.id` | Paystack has no top-level event id |
| `eventKey.flutterwave(body)` | `event` + `data.id` | |
| `eventKey.sqs(record)` | `messageId` | |
| `eventKey.job(queue, job)` | `job.id` | BullMQ/Bull retries reuse the job |
| `eventKey.fromHeader(headers, name)` | any header | |

Never build keys from `Date.now()`, `Math.random()`, or `uuid()`. They differ on every retry, so
nothing is ever deduplicated.

## Adapters

```ts
import { withGuard, withGuardJob, withGuardRoute } from "@retrysafe/guard";

// Express: duplicate -> 200, in-progress -> 409, errors -> next(err)
app.post("/webhooks/x", verify, withGuard(guard, (req) => eventKey.stripe(req.event), async (req, res, tx) => { /* ... */ res.sendStatus(200); }));

// Next.js App Router (and other fetch-style frameworks); getKey reads a clone of the request
export const POST = withGuardRoute(guard, (req) => eventKey.github(req.headers), async (req, tx) => Response.json({ ok: true }));

// BullMQ: duplicates complete quietly; in-progress throws so the queue retries later
new Worker("invoices", withGuardJob(guard, (job) => eventKey.job("invoices", job), async (job, tx) => { /* ... */ }));
```

`memoryGuard()` is for tests and single-process development only.

## The patterns, and the two mistakes they avoid

The [retrysafe safe-patterns guide](https://github.com/sammy440/retrysafe/blob/main/docs/patterns.md)
covers them in more depth. In short:

- **Record first, then do the work:** safe against duplicates, but a crash after the record loses the
  event. retrysafe reports this as `record-before-effect-no-tx`.
- **Do the work, then record:** safe against loss, but a crash before the record causes a duplicate.
  retrysafe reports this as `effect-before-record`.

The guards here avoid both mistakes. The database guards commit the record and the work together.
The Redis guard records a lease that expires or is released on failure.

## License

MIT
