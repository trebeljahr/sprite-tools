CREATE TABLE IF NOT EXISTS video_budgets (
  owner_id text PRIMARY KEY,
  available bigint NOT NULL DEFAULT 0 CHECK (available >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0)
);
-- Global budget must be explicitly funded, just like each account.
INSERT INTO video_budgets(owner_id) VALUES ('__global__') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS video_jobs (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id),
  request_key uuid NOT NULL,
  cost bigint NOT NULL CHECK (cost > 0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','submitted','done','failed','uncertain')),
  provider_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, request_key)
);
CREATE INDEX IF NOT EXISTS video_jobs_owner ON video_jobs(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS video_credit_grants (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
