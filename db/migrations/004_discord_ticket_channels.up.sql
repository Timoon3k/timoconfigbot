-- Observed Ticket Tool channels only. This table does NOT authorize an owner,
-- take payments or grant Discord roles. Discord interaction identity remains authoritative.
CREATE TABLE discord_ticket_channels (
  guild_id text NOT NULL CHECK (guild_id ~ '^[0-9]{17,20}$'),
  channel_id text NOT NULL CHECK (channel_id ~ '^[0-9]{17,20}$'),
  discord_category_id text NOT NULL CHECK (discord_category_id ~ '^[0-9]{17,20}$'),
  source text NOT NULL CHECK (source IN ('gateway')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);
CREATE INDEX discord_ticket_channels_category_idx
  ON discord_ticket_channels(guild_id, discord_category_id, observed_at DESC);
