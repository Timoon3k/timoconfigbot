-- TimonConfigs Supabase initial schema bootstrap
-- Source: github.com/Timoon3k/timoconfigbot branch deploy/hostinger-business
-- Use ONLY on a fresh, empty TimonConfigs database.
-- Do not modify these migration bodies or hashes. All changes roll back on error.
-- Later Node migration runner will recognise versions/checksums as already applied.

BEGIN;
SET LOCAL search_path = public, extensions, pg_catalog;
SELECT pg_advisory_xact_lock(71429001);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
DO $timon_guard$ BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations) THEN
    RAISE EXCEPTION 'Tim onConfigs schema_migrations is not empty. Stop and use existing migration runner.';
  END IF;
END $timon_guard$;

-- === 001_membership_backend ===
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE app_role AS ENUM ('customer', 'support', 'admin');
CREATE TYPE product_billing AS ENUM ('one_time', 'subscription');
CREATE TYPE order_status AS ENUM ('pending', 'paid', 'cancelled', 'failed', 'refunded', 'disputed');
CREATE TYPE payment_status AS ENUM ('succeeded', 'failed', 'refunded', 'disputed');
CREATE TYPE subscription_status AS ENUM ('pending', 'active', 'past_due', 'cancel_scheduled', 'cancelled', 'expired', 'suspended');
CREATE TYPE entitlement_tier AS ENUM ('VIP_MONTHLY', 'VIP_LIFETIME');
CREATE TYPE payment_event_status AS ENUM ('processing', 'processed', 'failed');
CREATE TYPE discord_job_status AS ENUM ('queued', 'processing', 'retry', 'succeeded', 'member_absent', 'dead_letter');

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role app_role NOT NULL DEFAULT 'customer',
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = btrim(email)),
  CHECK (length(password_hash) >= 32)
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_active_idx ON user_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE discord_accounts (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  discord_user_id varchar(32) NOT NULL UNIQUE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  unlinked_at timestamptz,
  CHECK (discord_user_id ~ '^[0-9]{17,32}$')
);

CREATE TABLE membership_products (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  price_minor integer NOT NULL CHECK (price_minor > 0),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  billing product_billing NOT NULL,
  duration_months integer,
  entitlement_tier entitlement_tier NOT NULL,
  discord_role_key text NOT NULL CHECK (discord_role_key IN ('VIP_MONTHLY', 'VIP_LIFETIME')),
  license_terms text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((code = 'VIP_LIFETIME' AND duration_months IS NULL AND entitlement_tier = 'VIP_LIFETIME' AND license_terms IS NOT NULL)
      OR (code <> 'VIP_LIFETIME' AND duration_months = 1 AND entitlement_tier = 'VIP_MONTHLY'))
);

INSERT INTO membership_products(code, display_name, price_minor, currency, billing, duration_months, entitlement_tier, discord_role_key, license_terms)
VALUES
 ('VIP_MONTHLY_ONCE', 'VIP Monthly — One-Time', 4000, 'EUR', 'one_time', 1, 'VIP_MONTHLY', 'VIP_MONTHLY', NULL),
 ('VIP_MONTHLY_AUTO', 'VIP Monthly — Auto-Renew', 4000, 'EUR', 'subscription', 1, 'VIP_MONTHLY', 'VIP_MONTHLY', NULL),
 ('VIP_LIFETIME', 'VIP Lifetime', 10000, 'EUR', 'one_time', NULL, 'VIP_LIFETIME', 'VIP_LIFETIME',
  'No preset expiration while the defined covered service and catalog are operated; published Lifetime Membership Terms govern service termination and exclusions.');

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  product_code text NOT NULL REFERENCES membership_products(code),
  provider text NOT NULL,
  provider_order_id text NOT NULL,
  idempotency_key text NOT NULL,
  status order_status NOT NULL DEFAULT 'pending',
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE(provider, provider_order_id),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX orders_user_created_idx ON orders(user_id, created_at DESC);

CREATE TABLE billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  product_code text NOT NULL REFERENCES membership_products(code) CHECK (product_code = 'VIP_MONTHLY_AUTO'),
  provider text NOT NULL,
  provider_subscription_id text NOT NULL,
  status subscription_status NOT NULL DEFAULT 'pending',
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_subscription_id),
  CHECK (current_period_end IS NULL OR current_period_start IS NOT NULL AND current_period_end > current_period_start)
);
CREATE UNIQUE INDEX only_one_live_auto_subscription_per_user
  ON billing_subscriptions(user_id)
  WHERE status IN ('pending', 'active', 'past_due', 'cancel_scheduled', 'suspended');

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  order_id uuid REFERENCES orders(id),
  subscription_id uuid REFERENCES billing_subscriptions(id),
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  status payment_status NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  paid_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  refunded_at timestamptz,
  disputed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_payment_id),
  CHECK (period_end IS NULL OR period_start IS NOT NULL AND period_end > period_start)
);
CREATE INDEX payments_user_created_idx ON payments(user_id, created_at DESC);

CREATE TABLE membership_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  product_code text NOT NULL REFERENCES membership_products(code),
  tier entitlement_tier NOT NULL,
  payment_id uuid NOT NULL UNIQUE REFERENCES payments(id),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((tier = 'VIP_LIFETIME' AND valid_until IS NULL) OR (tier = 'VIP_MONTHLY' AND valid_until > valid_from)),
  CHECK ((revoked_at IS NULL AND revocation_reason IS NULL) OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);
CREATE INDEX entitlements_active_user_idx ON membership_entitlements(user_id, tier, valid_from, valid_until) WHERE revoked_at IS NULL;

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  correlation_id uuid NOT NULL,
  status payment_event_status NOT NULL DEFAULT 'processing',
  verified_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  last_error_code text,
  last_error_message text,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  UNIQUE(provider, provider_event_id)
);
CREATE INDEX payment_events_status_idx ON payment_events(status, received_at);

CREATE TABLE discord_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id),
  desired_tier text NOT NULL CHECK (desired_tier IN ('FREE', 'VIP_MONTHLY', 'VIP_LIFETIME')),
  reason text NOT NULL,
  deduplication_key text NOT NULL UNIQUE,
  status discord_job_status NOT NULL DEFAULT 'queued',
  dry_run boolean NOT NULL DEFAULT true CHECK (dry_run = true),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX discord_jobs_claim_idx ON discord_sync_jobs(status, available_at) WHERE status IN ('queued', 'retry');

CREATE TABLE administrative_audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES app_users(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'system', 'payment_provider')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  correlation_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_target_idx ON administrative_audit_logs(target_type, target_id, created_at DESC);
CREATE INDEX audit_actor_idx ON administrative_audit_logs(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'administrative_audit_logs is append-only';
END $$;
CREATE TRIGGER administrative_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON administrative_audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

INSERT INTO schema_migrations(version, checksum)
VALUES ('001_membership_backend', 'a637d75ac625015cd861cf94c560866a6799a306008b1c5086e31c6916f0b750');

-- === 002_discord_automation ===
ALTER TABLE discord_sync_jobs
  ADD COLUMN target_discord_id varchar(32) CHECK (target_discord_id ~ '^[0-9]{17,20}$'),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN correlation_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX discord_jobs_leases_idx ON discord_sync_jobs(lease_expires_at) WHERE status = 'processing';
CREATE INDEX discord_jobs_user_idx ON discord_sync_jobs(user_id, created_at DESC, id);

CREATE TABLE discord_identity_reservations (
  discord_user_id varchar(32) PRIMARY KEY CHECK (discord_user_id ~ '^[0-9]{17,20}$'),
  user_id uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO discord_identity_reservations(discord_user_id,user_id)
  SELECT discord_user_id,user_id FROM discord_accounts;

CREATE TABLE discord_oauth_states (
  state_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_binding char(64) NOT NULL,
  verifier_ciphertext text NOT NULL,
  expected_discord_id varchar(32),
  replacement_confirmed boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discord_oauth_expiry_idx ON discord_oauth_states(expires_at);

CREATE TABLE discord_role_ownership (
  guild_id varchar(32) NOT NULL,
  discord_user_id varchar(32) NOT NULL,
  role_id varchar(32) NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id),
  source text NOT NULL CHECK (source IN ('mock_seed','approved_migration','bot_assignment')),
  approval_reference text NOT NULL,
  actor_user_id uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(guild_id,discord_user_id,role_id)
);

CREATE TABLE discord_sync_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid REFERENCES discord_sync_jobs(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  discord_user_id varchar(32),
  correlation_id uuid NOT NULL,
  attempt integer NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('preview','noop','retry','dead_letter','member_absent','unlinked','lease_recovered')),
  error_code text,
  preview jsonb,
  mode text NOT NULL DEFAULT 'dry-run' CHECK (mode = 'dry-run'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX discord_history_user_idx ON discord_sync_history(user_id,id DESC);
CREATE INDEX discord_history_job_idx ON discord_sync_history(job_id,id DESC);
CREATE TRIGGER discord_sync_history_immutable BEFORE UPDATE OR DELETE ON discord_sync_history
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE discord_mock_members (
  guild_id varchar(32) NOT NULL,
  discord_user_id varchar(32) NOT NULL,
  roles jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(roles) = 'array'),
  present boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(guild_id,discord_user_id)
);

CREATE TABLE discord_runtime (
  name text PRIMARY KEY,
  next_request_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  cursor_user_id uuid,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  last_scan_at timestamptz
);
CREATE INDEX discord_accounts_scan_idx ON discord_accounts(user_id) WHERE unlinked_at IS NULL;

INSERT INTO schema_migrations(version, checksum)
VALUES ('002_discord_automation', '842bea8081aa121d437edb507b76bff59878061d6d303102b30583ed82d80389');

-- === 003_discord_completion ===
ALTER TABLE discord_mock_members ADD COLUMN pending boolean;
ALTER TABLE discord_sync_jobs DROP CONSTRAINT discord_sync_jobs_dry_run_check;
ALTER TABLE discord_sync_history DROP CONSTRAINT discord_sync_history_outcome_check;
ALTER TABLE discord_sync_history ADD CONSTRAINT discord_sync_history_outcome_check
  CHECK (outcome IN ('preview','noop','retry','dead_letter','member_absent','unlinked','lease_recovered','applied'));
ALTER TABLE discord_sync_history DROP CONSTRAINT discord_sync_history_mode_check;
ALTER TABLE discord_sync_history ADD CONSTRAINT discord_sync_history_mode_check CHECK (mode IN ('dry-run','test-guild'));

CREATE TABLE discord_member_jobs (
  guild_id varchar(32) NOT NULL CHECK (guild_id ~ '^[0-9]{17,20}$'),
  discord_user_id varchar(32) NOT NULL CHECK (discord_user_id ~ '^[0-9]{17,20}$'),
  requested_version bigint NOT NULL DEFAULT 1,
  processed_version bigint NOT NULL DEFAULT 0,
  claimed_version bigint,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','retry','succeeded','dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  pending boolean,
  present boolean NOT NULL DEFAULT true,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(guild_id,discord_user_id)
);
CREATE INDEX discord_member_jobs_claim_idx ON discord_member_jobs(available_at)
  WHERE status IN ('queued','retry','processing');
CREATE TABLE discord_gateway_events (
  guild_id varchar(32) NOT NULL,
  session_id text NOT NULL,
  sequence bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(guild_id,session_id,sequence)
);
-- A committed intent survives a worker/database rollback. Uncertain outcomes never authorize removal.
CREATE TABLE discord_role_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id varchar(32) NOT NULL,
  discord_user_id varchar(32) NOT NULL,
  role_id varchar(32) NOT NULL,
  user_id uuid,
  operation text NOT NULL CHECK (operation IN ('add','remove')),
  status text NOT NULL DEFAULT 'intent' CHECK (status IN ('intent','confirmed','uncertain','obsolete')),
  approval_reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
CREATE INDEX discord_operations_identity_idx ON discord_role_operations(guild_id,discord_user_id,role_id,created_at DESC);
ALTER TABLE discord_runtime ADD COLUMN member_cursor varchar(32);

INSERT INTO schema_migrations(version, checksum)
VALUES ('003_discord_completion', 'b850add5b69e452321c8a61b2f56ad9f6c2503c2a81139d16d0e63e979fbdfe6');

COMMIT;

-- Verify: 3 rows should be present, plus 3 essential tables.
SELECT version, checksum, applied_at
FROM schema_migrations ORDER BY version;
SELECT to_regclass('public.app_users') AS app_users,
       to_regclass('public.discord_sync_jobs') AS discord_sync_jobs,
       to_regclass('public.discord_member_jobs') AS discord_member_jobs;
