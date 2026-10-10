import pg from 'pg';

const { Pool } = pg;
export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createPool(connectionString: string): DatabasePool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'timonconfigs-membership-backend',
  });
}

export async function inTransaction<T>(pool: DatabasePool, operation: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
