import pg from "pg";

const { Pool } = pg;
export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function databasePoolOptions(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): pg.PoolConfig {
  const url = new URL(connectionString);
  const mode = env.DB_CONNECTION_MODE ?? "direct";
  if (!["direct", "session"].includes(mode) || url.port === "6543")
    throw new Error(
      "Session locks require direct or session pooling; transaction pooling is prohibited.",
    );
  const sslMode =
    env.DB_SSL_MODE ?? (env.NODE_ENV === "production" ? "require" : "disable");
  if (
    !["require", "disable"].includes(sslMode) ||
    (env.NODE_ENV === "production" && sslMode !== "require")
  )
    throw new Error("Production PostgreSQL requires verified TLS.");
  if (
    sslMode === "disable" &&
    (url.hostname.endsWith(".supabase.co") ||
      url.hostname.endsWith(".supabase.com"))
  )
    throw new Error("Supabase requires verified TLS.");
  if (url.searchParams.get("sslmode") === "disable" && sslMode === "require")
    throw new Error("Conflicting TLS configuration.");
  // pg URL SSL parameters can replace the explicit TLS verification object.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"])
    url.searchParams.delete(key);
  const max = Number(env.DB_POOL_MAX ?? 5);
  if (!Number.isInteger(max) || max < 4 || max > 10)
    throw new Error("DB_POOL_MAX must be between 4 and 10.");
  return {
    connectionString: url.toString(),
    max,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 1000,
    ssl:
      sslMode === "require"
        ? {
            rejectUnauthorized: true,
            ...(env.DB_CA_CERT ? { ca: env.DB_CA_CERT } : {}),
          }
        : false,
    application_name: "timonconfigs-membership-backend",
  };
}
export function createPool(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): DatabasePool {
  const pool = new Pool(databasePoolOptions(connectionString, env));
  pool.on("error", () =>
    process.stderr.write(
      JSON.stringify({ event: "database_idle_connection_failed" }) + "\n",
    ),
  );
  return pool;
}

export async function inTransaction<T>(
  pool: DatabasePool,
  operation: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
