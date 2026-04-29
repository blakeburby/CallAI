require("dotenv/config");

const { readdir, readFile } = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");

const projectRoot = path.resolve(__dirname, "../..");
const migrationsDir = path.join(projectRoot, "db", "migrations");

const main = async () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: resolveDatabaseSsl(databaseUrl),
    allowExitOnIdle: true
  });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        filename text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const existing = await client.query(
        "select filename from schema_migrations where filename = $1",
        [file]
      );

      if (existing.rowCount) {
        console.log(`Skipping ${file}`);
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");
      await client.query("begin");

      try {
        console.log(`Applying ${file}`);
        await client.query(sql);
        await client.query(
          "insert into schema_migrations (filename) values ($1)",
          [file]
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    console.log("Database migrations complete");
  } finally {
    await client.end();
  }
};

const resolveDatabaseSsl = (databaseUrl) => {
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
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
