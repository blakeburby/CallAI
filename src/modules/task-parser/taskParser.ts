import { z } from "zod";
import { completeJson } from "../../services/openaiService.js";
import {
  normalizedActions,
  permissionLevels,
  type DeveloperTask,
  type NormalizedAction,
  type PermissionLevel
} from "../../types/operator.js";
import { logger } from "../../utils/logger.js";

const developerTaskSchema = z
  .object({
    action: z.enum(normalizedActions),
    title: z.string().min(3).max(140),
    repoAlias: z.string().min(1).max(120).optional(),
    repoId: z.string().min(1).optional(),
    branchPolicy: z.literal("new_branch_required"),
    permissionRequired: z.enum(permissionLevels),
    instructions: z.string().min(3).max(5000),
    acceptanceCriteria: z.array(z.string().min(1).max(280)).min(1).max(8),
    chatTarget: z.string().min(1).max(140).optional(),
    confidence: z.number().min(0).max(1),
    postApprovalAction: z
      .object({
        action: z.enum(["commit_changes", "open_pull_request"]),
        branchName: z.string().min(1).max(180).optional(),
        commitMessage: z.string().min(1).max(180).optional(),
        pullRequestTitle: z.string().min(1).max(180).optional(),
        pullRequestBody: z.string().min(1).max(4000).optional(),
        draft: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const parseDeveloperTask = async (
  utterance: string
): Promise<DeveloperTask> => {
  const trimmed = utterance.trim();

  if (!trimmed) {
    throw new Error("A spoken request is required.");
  }

  try {
    const parsed = await completeJson<unknown>({
      system:
        "Convert spoken developer operations requests into one DeveloperTask JSON object. Use exactly these actions: inspect_repo, edit_files, run_tests, create_branch, commit_changes, open_pull_request, send_chat_message, summarize_project, query_logs, delegate_to_codex, continue_existing_task. Use branchPolicy new_branch_required. Mark deleting files, force pushing, merging to main, production deploys, mass rewrites, and environment or secret changes as destructive_admin. Mark commits, pushes, pull requests, and external chat sends as full_write. Mark file edits and test additions as safe_write. Mark inspection, summaries, and logs as read_only. Include practical acceptance criteria and a confidence score from 0 to 1.",
      user: trimmed,
      maxTokens: 800
    });

    if (parsed) {
      return developerTaskSchema.parse(parsed);
    }
  } catch (error) {
    logger.warn("OpenAI task parsing failed; using heuristic parser", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return heuristicParse(trimmed);
};

const heuristicParse = (utterance: string): DeveloperTask => {
  const lower = utterance.toLowerCase();
  const action = inferAction(lower);
  const permissionRequired = inferPermission(lower, action);
  const repoAlias = inferRepoAlias(utterance);
  const title = buildTitle(utterance, action);

  return {
    action,
    title,
    ...(repoAlias ? { repoAlias } : {}),
    branchPolicy: "new_branch_required",
    permissionRequired,
    instructions: utterance,
    acceptanceCriteria: buildAcceptanceCriteria(action, lower),
    confidence: repoAlias ? 0.72 : 0.58
  };
};

const inferAction = (lower: string): NormalizedAction => {
  if (/\b(continue|resume|keep working|pick back up)\b/.test(lower)) {
    return "continue_existing_task";
  }

  if (/\b(open a pr|pull request|draft pr|create pr)\b/.test(lower)) {
    return "open_pull_request";
  }

  if (/\b(commit|push)\b/.test(lower)) {
    return "commit_changes";
  }

  if (/\b(branch|new branch|checkout)\b/.test(lower)) {
    return "create_branch";
  }

  if (/\b(test|tests|failing|ci)\b/.test(lower)) {
    return "run_tests";
  }

  if (/\b(log|logs|deployment failed|why.*failed|error output)\b/.test(lower)) {
    return "query_logs";
  }

  if (/\b(chat|slack|message|post|send.*summary|update the team)\b/.test(lower)) {
    return "send_chat_message";
  }

  if (/\b(summarize|summary|what changed|progress)\b/.test(lower)) {
    return "summarize_project";
  }

  if (/\b(inspect|look at|review|read|check)\b/.test(lower)) {
    return "inspect_repo";
  }

  if (/\b(fix|edit|update|refactor|change|patch|implement|add)\b/.test(lower)) {
    return "delegate_to_codex";
  }

  return "delegate_to_codex";
};

const inferPermission = (
  lower: string,
  action: NormalizedAction
): PermissionLevel => {
  if (
    /\b(delete|remove files|force push|merge to main|merge into main|production deploy|deploy to prod|env var|secret|secrets|mass rewrite)\b/.test(
      lower
    )
  ) {
    return "destructive_admin";
  }

  if (
    action === "commit_changes" ||
    action === "open_pull_request" ||
    action === "send_chat_message" ||
    /\b(push|commit|pull request|pr|send|post)\b/.test(lower)
  ) {
    return "full_write";
  }

  if (
    action === "inspect_repo" ||
    action === "summarize_project" ||
    action === "query_logs"
  ) {
    return "read_only";
  }

  return "safe_write";
};

const inferRepoAlias = (utterance: string): string | undefined => {
  const patterns = [
    /\b(?:in|inside|for|on|open)\s+(?:the\s+)?([a-z0-9_\-/ ]{2,80}?)\s+repo\b/i,
    /\b(my\s+main\s+repo|main\s+repo|current\s+repo|this\s+repo)\b/i,
    /\b(CallAI)\b/i
  ];

  for (const pattern of patterns) {
    const match = utterance.match(pattern);
    const alias = match?.[1]?.trim();

    if (alias) {
      return alias;
    }
  }

  return undefined;
};

const buildTitle = (utterance: string, action: NormalizedAction): string => {
  const clean = utterance
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "")
    .trim();

  if (clean.length <= 90) {
    return clean;
  }

  const actionLabel = action.replaceAll("_", " ");
  return `${actionLabel}: ${clean.slice(0, 72).trim()}...`;
};

const buildAcceptanceCriteria = (
  action: NormalizedAction,
  lower: string
): string[] => {
  const criteria = ["The interpreted task is logged with a clear audit trail."];

  if (action === "inspect_repo" || action === "summarize_project") {
    criteria.push("The repo findings are summarized with relevant files or risks.");
  } else if (action === "run_tests") {
    criteria.push("Relevant tests or checks are run and failures are captured.");
  } else if (action === "query_logs") {
    criteria.push("The most likely failure reason is identified from logs.");
  } else if (action === "send_chat_message") {
    criteria.push("The outgoing message is prepared or sent only after permission checks.");
  } else {
    criteria.push("Code changes happen on a new branch or isolated worktree.");
    criteria.push("Tests or validation are run before any commit or push.");
  }

  if (lower.includes("readme")) {
    criteria.push("README changes are concise and accurate.");
  }

  return criteria;
};

export const validateDeveloperTask = (value: unknown): DeveloperTask => {
  return developerTaskSchema.parse(value);
};
