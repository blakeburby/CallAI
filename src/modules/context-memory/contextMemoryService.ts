import { database } from "../../services/dbService.js";
import type { DeveloperTask, RepoRecord } from "../../types/operator.js";

type RepoResolution = {
  repo: RepoRecord | null;
  confidence: number;
  reason: string;
  candidates: RepoRecord[];
};

export const contextMemory = {
  async resolveRepo(
    task: DeveloperTask,
    repoHint?: string
  ): Promise<RepoResolution> {
    if (task.repoId) {
      const repo = await database.findRepoById(task.repoId);

      return {
        repo,
        confidence: repo ? 1 : 0,
        reason: repo ? "repo_id" : "repo_id_not_found",
        candidates: repo ? [repo] : []
      };
    }

    const alias = repoHint || task.repoAlias;

    if (alias) {
      const repo = await database.findRepoByAlias(alias);

      if (repo) {
        return {
          repo,
          confidence: 0.92,
          reason: "alias_match",
          candidates: [repo]
        };
      }
    }

    const repos = await database.listRepos();

    if (repos.length === 1) {
      return {
        repo: repos[0],
        confidence: 0.68,
        reason: "single_known_repo",
        candidates: repos
      };
    }

    if (repos.length > 1) {
      return {
        repo: null,
        confidence: 0.25,
        reason: "ambiguous_repo",
        candidates: repos.slice(0, 5)
      };
    }

    return {
      repo: null,
      confidence: 0,
      reason: "no_repos_configured",
      candidates: []
    };
  },

  describeRepo(repo: RepoRecord | null): string | null {
    if (!repo) {
      return null;
    }

    return `${repo.owner}/${repo.name}`;
  }
};
