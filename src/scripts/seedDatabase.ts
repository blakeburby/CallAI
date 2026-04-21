import "dotenv/config";
import { createPostgresPool } from "../services/postgresService.js";

const main = async (): Promise<void> => {
  const pool = createPostgresPool();

  if (!pool) {
    throw new Error("DATABASE_URL is required to seed the database.");
  }

  const defaultPath = process.env.DEFAULT_REPO_PATH || process.cwd();
  const defaultName =
    process.env.DEFAULT_REPO_NAME || defaultPath.split("/").filter(Boolean).pop();

  if (!defaultName) {
    throw new Error("DEFAULT_REPO_NAME or DEFAULT_REPO_PATH is required.");
  }

  const owner = process.env.DEFAULT_REPO_OWNER || "local";
  const cloneUrl =
    process.env.DEFAULT_REPO_URL ||
    `https://github.com/${owner}/${defaultName}.git`;
  const defaultBranch = process.env.DEFAULT_REPO_BRANCH || "main";
  const codexCloudEnvId = process.env.DEFAULT_CODEX_CLOUD_ENV_ID || null;
  const aliases = uniqueAliases([
    "main repo",
    "current repo",
    "this repo",
    "callai",
    defaultName,
    `${owner}/${defaultName}`,
    ...(process.env.DEFAULT_REPO_ALIASES?.split(",") ?? [])
  ]);

  const client = await pool.connect();

  try {
    await client.query("begin");
    const repo = await client.query<{ id: string }>(
      `insert into repos (
         provider, owner, name, clone_url, default_branch, local_path, codex_cloud_env_id
       )
       values ('github', $1, $2, $3, $4, $5, $6)
       on conflict (owner, name) do update
         set clone_url = excluded.clone_url,
             default_branch = excluded.default_branch,
             local_path = excluded.local_path,
             codex_cloud_env_id = excluded.codex_cloud_env_id
       returning id`,
      [owner, defaultName, cloneUrl, defaultBranch, defaultPath, codexCloudEnvId]
    );
    const repoId = repo.rows[0]?.id;

    if (!repoId) {
      throw new Error("Repo seed failed: no repo id returned.");
    }

    for (const alias of aliases) {
      await client.query(
        `insert into repo_aliases (repo_id, alias)
         values ($1, $2)
         on conflict (alias) do update
           set repo_id = excluded.repo_id`,
        [repoId, alias]
      );
    }

    await client.query("commit");
    console.log(`Seeded ${owner}/${defaultName} with ${aliases.length} aliases`);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

function uniqueAliases(values: string[]): string[] {
  return [...new Set(values.map(normalizeAlias).filter(Boolean))];
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase().replace(/\s+/g, "-");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
