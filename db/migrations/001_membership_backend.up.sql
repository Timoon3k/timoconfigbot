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
