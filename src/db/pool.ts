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
  // Hostinger environment fields may not preserve multiline PEM. Allow an
  // optional Base64-encoded Supabase CA certificate without disabling TLS verification.
  const caBase64 = env.DB_CA_CERT_BASE64?.trim();
  const directCa = env.DB_CA_CERT;
  if (caBase64 && directCa)
    throw new Error("Set only one of DB_CA_CERT or DB_CA_CERT_BASE64.");
  let ca = directCa;
  if (caBase64) {
    if (
      caBase64.length > 32768 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(caBase64)
    )
      throw new Error("Invalid DB_CA_CERT_BASE64 encoding.");
    ca = Buffer.from(caBase64, "base64").toString("utf8");
  }
  if (ca && (!ca.includes("-----BEGIN CERTIFICATE-----") || !ca.includes("-----END CERTIFICATE-----")))
    throw new Error("Database CA must contain a PEM certificate.");
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
            ...(ca ? { ca } : {}),
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
