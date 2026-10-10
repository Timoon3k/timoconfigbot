import { loadConfig } from '../config.js';
import { migrateDown, migrateUp } from './migrate.js';
import { createPool } from './pool.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  if (process.argv[2] === 'down') await migrateDown(pool);
  else if (process.argv[2] === 'up') await migrateUp(pool);
  else throw new Error('Usage: db:migrate or db:rollback');
} finally {
  await pool.end();
}
