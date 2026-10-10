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
