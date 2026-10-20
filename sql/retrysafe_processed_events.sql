-- Processed-event keys for @retrysafe/guard (postgresGuard / prismaGuard).
-- The primary key is what makes the claim atomic: never drop it.
CREATE TABLE IF NOT EXISTS "retrysafe_processed_events" (
  "key" text PRIMARY KEY,
  "processed_at" timestamptz NOT NULL DEFAULT now()
);

-- Optional housekeeping: keep keys at least as long as your providers retry (Stripe: 3 days).
-- DELETE FROM "retrysafe_processed_events" WHERE "processed_at" < now() - interval '30 days';
