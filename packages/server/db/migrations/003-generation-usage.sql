-- Legacy failed jobs did not record whether credit was returned. Keep them unknown.
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE video_jobs ADD COLUMN IF NOT EXISTS billing_status text CHECK (billing_status IN ('charged','refunded'));
UPDATE video_jobs SET billing_status='charged' WHERE status='done' AND billing_status IS NULL;
