-- Refuse destructive rollback once tickets have been observed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM discord_ticket_channels LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot drop discord_ticket_channels with observed tickets.';
  END IF;
END $$;
DROP TABLE discord_ticket_channels;
