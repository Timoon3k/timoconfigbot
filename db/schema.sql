-- Legacy reference schema retained for blueprint history.
-- The canonical Phase 1 schema is versioned in db/migrations/*.sql and must be
-- applied with `npm run db:migrate`. Do not apply this file to a Phase 1 database.
-- Reference schema for PostgreSQL 15+. Review and migrate before production.
-- Application API accesses tables server-side only; never expose DB to browsers.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  discord_user_id varchar(32) UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE membership_plan AS ENUM ('VIP_MONTHLY_ONCE','VIP_MONTHLY_AUTO','VIP_LIFETIME');
CREATE TYPE payment_state AS ENUM ('pending','paid','refunded','reversed','failed');
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  plan membership_plan NOT NULL,
  provider text NOT NULL,
  provider_order_id text,
  state payment_state NOT NULL DEFAULT 'pending',
  amount_minor integer NOT NULL CHECK (amount_minor IN (4000,10000)),
  currency char(3) NOT NULL DEFAULT 'EUR' CHECK (currency='EUR'),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE(provider, provider_order_id),
  CHECK ((plan='VIP_LIFETIME' AND amount_minor=10000) OR (plan<>'VIP_LIFETIME' AND amount_minor=4000))
);

CREATE TABLE billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  provider text NOT NULL,
  provider_subscription_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','active','past_due','cancel_scheduled','cancelled','expired','suspended')),
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  paid_through timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_subscription_id)
);
CREATE UNIQUE INDEX only_one_live_auto_subscription_per_user
ON billing_subscriptions (user_id)
WHERE state IN ('pending','active','past_due','cancel_scheduled','suspended');

CREATE TABLE entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  tier text NOT NULL CHECK (tier IN ('VIP_MONTHLY','VIP_LIFETIME')),
  source_provider text NOT NULL,
  source_payment_id text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_provider,source_payment_id),
  CHECK ((tier='VIP_LIFETIME' AND valid_until IS NULL) OR (tier='VIP_MONTHLY' AND valid_until IS NOT NULL AND valid_until>valid_from))
);
CREATE INDEX entitlements_user_active_idx ON entitlements(user_id,valid_until,revoked_at);

CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  verified_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_error text,
  UNIQUE(provider, provider_event_id)
);

CREATE TABLE discord_role_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  desired_role text NOT NULL CHECK (desired_role IN ('FREE','VIP_MONTHLY','VIP_LIFETIME')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','in_progress','succeeded','retry','dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX discord_role_jobs_pending_idx ON discord_role_jobs(status,next_attempt_at);

CREATE TABLE content_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  device text NOT NULL CHECK (device IN ('CRONUS_ZEN','XIM_MATRIX')),
  game text NOT NULL,
  min_access text NOT NULL CHECK (min_access IN ('FREE','VIP')),
  version text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  sha256_hex char(64),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE download_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  file_id uuid NOT NULL REFERENCES content_files(id),
  allowed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Example access query with current time and refund/reversal handling:
-- SELECT EXISTS (
--   SELECT 1 FROM entitlements WHERE user_id=$1 AND valid_from<=now()
--   AND (valid_until IS NULL OR valid_until>now())
--   AND (revoked_at IS NULL OR revoked_at>now())
-- );
