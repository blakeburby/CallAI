import pg, {
  type Pool as PgPool,
  type PoolConfig
} from "pg";
import { logger } from "../utils/logger.js";

const { Pool, types } = pg;

let typeParsersConfigured = false;

export const createPostgresPool = (): PgPool | null => {
  configurePostgresTypeParsers();

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return null;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: Number(
      process.env.DATABASE_CONNECTION_TIMEOUT_MS ?? 15000
    ),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30000),
    allowExitOnIdle: true,
    keepAlive: true,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    maxUses: Number(process.env.DATABASE_POOL_MAX_USES ?? 500),
    ssl: resolveDatabaseSsl(databaseUrl)
  });

  pool.on("connect", (client) => {
    client.on("error", (error) => {
      logger.warn("Postgres client error", {
        error: error.message
      });
    });
  });

  pool.on("error", (error) => {
    logger.error("Postgres pool error", { error: error.message });
  });

  return pool;
};

export function resolveDatabaseSsl(databaseUrl: string): PoolConfig["ssl"] {
  const setting = (process.env.DATABASE_SSL || "auto").toLowerCase();

  if (["false", "disable", "disabled", "off", "0"].includes(setting)) {
    return false;
  }

  if (["true", "require", "required", "on", "1"].includes(setting)) {
    return { rejectUnauthorized: false };
  }

  try {
    const parsed = new URL(databaseUrl);
    const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();

    if (sslMode === "disable") {
      return false;
    }

    if (sslMode === "require") {
      return { rejectUnauthorized: false };
    }

    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.includes("railway.internal")
    ) {
      return false;
    }
  } catch {
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: false };
}

function configurePostgresTypeParsers(): void {
  if (typeParsersConfigured) {
    return;
  }

  types.setTypeParser(1114, (value) => new Date(`${value}Z`).toISOString());
  types.setTypeParser(1184, (value) => new Date(value).toISOString());
  types.setTypeParser(1700, (value) => Number(value));
  typeParsersConfigured = true;
}
