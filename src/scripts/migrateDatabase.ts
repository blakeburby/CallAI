import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresPool } from "../services/postgresService.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, "../..");
const migrationsDir = path.join(projectRoot, "db", "migrations");

const main = async (): Promise<void> => {
  const pool = createPostgresPool();

  if (!pool) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const client = await pool.connect();

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
    client.release();
    await pool.end();
  }
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
