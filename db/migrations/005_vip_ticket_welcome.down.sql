DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM discord_ticket_channels WHERE source='reconcile') OR
     EXISTS(SELECT 1 FROM discord_ticket_selections) OR
     EXISTS(SELECT 1 FROM discord_ticket_welcome_jobs WHERE send_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot remove VIP ticket interaction or message evidence.';
  END IF;
END $$;
DROP TABLE discord_ticket_selections;
DROP TABLE discord_ticket_welcome_jobs;
ALTER TABLE discord_ticket_channels DROP CONSTRAINT discord_ticket_channels_source_check;
ALTER TABLE discord_ticket_channels ADD CONSTRAINT discord_ticket_channels_source_check CHECK(source IN ('gateway'));
