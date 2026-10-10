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
