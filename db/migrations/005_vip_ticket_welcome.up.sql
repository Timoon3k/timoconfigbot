ALTER TABLE discord_ticket_channels DROP CONSTRAINT discord_ticket_channels_source_check;
ALTER TABLE discord_ticket_channels ADD CONSTRAINT discord_ticket_channels_source_check CHECK(source IN ('gateway','reconcile'));
CREATE TABLE discord_ticket_welcome_jobs (
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','sent','blocked')),
  nonce varchar(25) NOT NULL UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  send_started_at timestamptz,
  message_id text CHECK(message_id ~ '^[0-9]{17,20}$'),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(guild_id,channel_id),
  FOREIGN KEY(guild_id,channel_id) REFERENCES discord_ticket_channels(guild_id,channel_id),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX discord_ticket_welcome_due_idx ON discord_ticket_welcome_jobs(guild_id,available_at) WHERE status IN ('queued','retry','processing');
CREATE TABLE discord_ticket_selections (
  interaction_id text PRIMARY KEY CHECK(interaction_id ~ '^[0-9]{17,20}$'),
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  discord_user_id text NOT NULL CHECK(discord_user_id ~ '^[0-9]{17,20}$'),
  product_code text NOT NULL CHECK(product_code IN ('VIP_MONTHLY_AUTO','VIP_LIFETIME')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(guild_id,channel_id) REFERENCES discord_ticket_channels(guild_id,channel_id)
);
CREATE INDEX discord_ticket_selection_user_idx ON discord_ticket_selections(discord_user_id,created_at DESC);
