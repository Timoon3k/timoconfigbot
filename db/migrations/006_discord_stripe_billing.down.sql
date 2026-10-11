-- Financial evidence must not be removed during an application rollback.
DO $$ BEGIN
  RAISE EXCEPTION 'Migration 006 is additive and irreversible: disable billing features, retain payment and role evidence.';
END $$;
