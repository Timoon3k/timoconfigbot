-- Discord-only identity: no fabricated website accounts, email addresses or passwords.
CREATE TABLE discord_billing_principals (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL CHECK(guild_id ~ '^[0-9]{17,20}$'),
  discord_user_id text NOT NULL CHECK(discord_user_id ~ '^[0-9]{17,20}$'),
  stripe_account_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('test','live')),
  customer_id text,
  customer_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(guild_id,discord_user_id,stripe_account_id,mode),
  UNIQUE(stripe_account_id,mode,customer_id)
);
CREATE TABLE stripe_checkout_orders (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES discord_billing_principals(id),
  channel_id text NOT NULL CHECK(channel_id ~ '^[0-9]{17,20}$'),
  product_code text NOT NULL CHECK(product_code IN ('VIP_MONTHLY_AUTO','VIP_LIFETIME')),
  price_id text NOT NULL,
  legal_revision text NOT NULL,
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','creating','open','paid','expired')),
  consent_at timestamptz,
  upgrade_consent boolean NOT NULL DEFAULT false,
  session_id text UNIQUE,
  subscription_id text UNIQUE,
  payment_intent_id text UNIQUE,
  checkout_url_ciphertext text,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
  started_at timestamptz,
  recovery_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stripe_one_pending_order ON stripe_checkout_orders(principal_id) WHERE state IN ('prepared','creating','open');
CREATE TABLE stripe_billing_subscriptions (
  subscription_id text PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES discord_billing_principals(id),
  order_id uuid NOT NULL UNIQUE REFERENCES stripe_checkout_orders(id),
  price_id text NOT NULL,
  status text NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stripe_one_active_subscription ON stripe_billing_subscriptions(principal_id)
  WHERE status NOT IN ('canceled','incomplete_expired');
CREATE TABLE stripe_verified_payments (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES discord_billing_principals(id),
  order_id uuid NOT NULL REFERENCES stripe_checkout_orders(id),
  invoice_id text UNIQUE,
  payment_intent_id text NOT NULL UNIQUE,
  charge_id text NOT NULL UNIQUE,
  amount_minor integer NOT NULL CHECK(amount_minor IN (4000,10000)),
  currency text NOT NULL CHECK(currency='eur'),
  tier text NOT NULL CHECK(tier IN ('VIP_MONTHLY','VIP_LIFETIME')),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  refunded_minor integer NOT NULL DEFAULT 0 CHECK(refunded_minor >= 0 AND refunded_minor <= amount_minor),
  disputed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((tier='VIP_LIFETIME' AND valid_until IS NULL) OR
        (tier='VIP_MONTHLY' AND valid_until > valid_from AND invoice_id IS NOT NULL))
);
CREATE INDEX stripe_valid_entitlements ON stripe_verified_payments(principal_id,valid_until) WHERE refunded_minor=0 AND NOT disputed;
CREATE TABLE stripe_webhook_events (
  event_id text PRIMARY KEY,
  account_id text NOT NULL,
  mode text NOT NULL CHECK(mode IN ('test','live')),
  event_type text NOT NULL,
  object_id text NOT NULL,
  payload_hash text NOT NULL,
  source text NOT NULL DEFAULT 'signed_webhook' CHECK(source IN ('signed_webhook','canonical_reconciliation')),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','complete','blocked')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX stripe_events_due ON stripe_webhook_events(available_at) WHERE status='queued';
CREATE TABLE stripe_discord_interactions (
  interaction_id text PRIMARY KEY CHECK(interaction_id ~ '^[0-9]{17,20}$'),
  guild_id text NOT NULL CHECK(guild_id ~ '^[0-9]{17,20}$'),
  channel_id text NOT NULL CHECK(channel_id ~ '^[0-9]{17,20}$'),
  discord_user_id text NOT NULL CHECK(discord_user_id ~ '^[0-9]{17,20}$'),
  message_id text NOT NULL CHECK(message_id ~ '^[0-9]{17,20}$'),
  custom_id varchar(100) NOT NULL,
  token_ciphertext text,
  response_ciphertext text,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','complete','expired')),
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_interactions_due ON stripe_discord_interactions(available_at) WHERE state='queued';
CREATE TABLE stripe_vip_sync_state (
  principal_id uuid PRIMARY KEY REFERENCES discord_billing_principals(id),
  checked_at timestamptz NOT NULL DEFAULT '-infinity',
  outcome text NOT NULL DEFAULT 'pending',
  error_code text
);
ALTER TABLE discord_role_operations ADD COLUMN billing_principal_id uuid REFERENCES discord_billing_principals(id);
CREATE TABLE stripe_vip_role_ownership (
  principal_id uuid NOT NULL REFERENCES discord_billing_principals(id),
  role_id text NOT NULL CHECK(role_id ~ '^[0-9]{17,20}$'),
  operation_id uuid NOT NULL REFERENCES discord_role_operations(id),
  PRIMARY KEY(principal_id,role_id)
);
-- Supabase browser/API roles receive no policy. Only the trusted backend DB role accesses this ledger.
ALTER TABLE discord_billing_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_checkout_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_verified_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_discord_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_vip_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_vip_role_ownership ENABLE ROW LEVEL SECURITY;
