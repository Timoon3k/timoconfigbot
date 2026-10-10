-- Refuse rollback if live evidence exists: keep records needed to establish ownership.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM discord_role_operations) OR EXISTS(SELECT 1 FROM discord_sync_history WHERE mode='test-guild')
    THEN RAISE EXCEPTION 'Cannot roll back Discord completion with live operation evidence'; END IF;
END $$;
DROP TABLE discord_role_operations,discord_gateway_events,discord_member_jobs;
ALTER TABLE discord_mock_members DROP COLUMN pending;
ALTER TABLE discord_sync_jobs ADD CONSTRAINT discord_sync_jobs_dry_run_check CHECK (dry_run = true);
ALTER TABLE discord_sync_history DROP CONSTRAINT discord_sync_history_outcome_check;
ALTER TABLE discord_sync_history ADD CONSTRAINT discord_sync_history_outcome_check
  CHECK (outcome IN ('preview','noop','retry','dead_letter','member_absent','unlinked','lease_recovered'));
ALTER TABLE discord_sync_history DROP CONSTRAINT discord_sync_history_mode_check;
ALTER TABLE discord_sync_history ADD CONSTRAINT discord_sync_history_mode_check CHECK (mode='dry-run');
ALTER TABLE discord_runtime DROP COLUMN member_cursor;
