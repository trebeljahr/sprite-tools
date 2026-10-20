-- One row per paid Stripe Checkout Session, so a retried webhook never adds
-- the same credit twice. Amounts: credit in micro-dollars, payment in cents
-- before tax.
CREATE TABLE IF NOT EXISTS credit_purchases (
  checkout_session_id text PRIMARY KEY,
  owner_id text NOT NULL,
  credit_micros bigint NOT NULL CHECK (credit_micros > 0),
  paid_cents bigint NOT NULL CHECK (paid_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_purchases_owner ON credit_purchases(owner_id, created_at DESC);
