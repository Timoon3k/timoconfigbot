DROP INDEX discord_accounts_scan_idx;
DROP TABLE discord_runtime;
DROP TABLE discord_mock_members;
DROP TABLE discord_sync_history;
DROP TABLE discord_role_ownership;
DROP TABLE discord_oauth_states;
DROP TABLE discord_identity_reservations;
DROP INDEX discord_jobs_user_idx;
DROP INDEX discord_jobs_leases_idx;
ALTER TABLE discord_sync_jobs DROP COLUMN target_discord_id, DROP COLUMN lease_token,
  DROP COLUMN lease_expires_at, DROP COLUMN correlation_id;
