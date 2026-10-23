CREATE TABLE IF NOT EXISTS "retrysafe_processed_events" (
  "key" text PRIMARY KEY,
  "processed_at" timestamptz NOT NULL DEFAULT now()
);

