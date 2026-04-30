import {
  type DeveloperTask,
  type NormalizedAction,
  type PermissionLevel
} from "../../types/operator.js";

export const parseDeveloperTask = async (
  utterance: string
): Promise<DeveloperTask> => {
  const trimmed = utterance.trim();

  if (!trimmed) {
    throw new Error("A spoken request is required.");
  }

  return heuristicParse(trimmed);
};

const heuristicParse = (utterance: string): DeveloperTask => {
  const lower = utterance.toLowerCase();
  const action = inferAction(lower);
  const permissionRequired = inferPermission(lower, action);
  const repoAlias = inferRepoAlias(utterance);
  const title = buildTitle(utterance, action);
  const url = extractUrl(utterance, lower);
  const riskLevel = action === "desktop_control" ? inferDesktopRisk(lower) : undefined;
  const desktopMode = action === "desktop_control" ? inferDesktopMode(lower) : undefined;
  const targetApp = action === "desktop_control" ? inferTargetApp(utterance, lower, desktopMode) : undefined;
  const shellCommand = desktopMode === "local_shell" ? inferShellCommand(utterance) : undefined;
  const shellCwd = desktopMode === "local_shell" ? inferShellCwd(utterance, lower) : undefined;

  return {
    action,
    title,
    ...(repoAlias ? { repoAlias } : {}),
    branchPolicy: "new_branch_required",
    permissionRequired,
    instructions: utterance,
    acceptanceCriteria: buildAcceptanceCriteria(action, lower),
    ...(targetApp ? { targetApp } : {}),
    ...(desktopMode ? { desktopMode } : {}),
    ...(shellCommand ? { shellCommand } : {}),
    ...(shellCwd ? { shellCwd } : {}),
    ...(url ? { url } : {}),
    ...(riskLevel ? { riskLevel } : {}),
    confidence: repoAlias ? 0.72 : 0.58
  };
};

const inferAction = (lower: string): NormalizedAction => {
  if (
    /\b(chrome|browser|website|web site|url|navigate|open\s+(?:a\s+)?(?:site|website|webpage|page)|go to|visit|search (?:for|on|the web)|google|click|fill(?: out)?|type into|select from|web form)\b/.test(
      lower
    ) ||
    /\b(finder|terminal|system settings|settings app|mail|email|messages|notes|calendar|slack|desktop|downloads|documents|applications folder|open app|launch app|focus app|front window|screenshot|screen shot|mouse|keyboard|hotkey|press (?:cmd|command|control|option|shift)|run (?:the )?(?:command|shell)|shell command|execute (?:the )?command|list files|show files|delete files|remove files|trash files|enter (?:my )?password|type (?:my )?password|solve captcha|buy|purchase|checkout)\b/.test(
      lower
    ) ||
    /\b[a-z0-9-]+\.(?:com|org|net|ai|io|dev|app|co|edu|gov)\b/.test(lower)
  ) {
    return "desktop_control";
  }

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
  if (action === "desktop_control") {
    const riskLevel = inferDesktopRisk(lower);

    if (riskLevel === "blocked") {
      return "destructive_admin";
    }

    if (riskLevel === "needs_confirmation") {
      return "full_write";
    }

    return "safe_write";
  }

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
  } else if (action === "desktop_control") {
    criteria.push("The local Mac bridge runs the requested computer action.");
    criteria.push("Screen, shell, or app state is recorded in the audit log.");
    criteria.push("Sensitive computer actions are blocked or routed through confirmation.");
  } else {
    criteria.push("Code changes happen on a new branch or isolated worktree.");
    criteria.push("Tests or validation are run before any commit or push.");
  }

  if (lower.includes("readme")) {
    criteria.push("README changes are concise and accurate.");
  }

  return criteria;
};

const inferDesktopRisk = (
  lower: string
): NonNullable<DeveloperTask["riskLevel"]> => {
  if (
    /\b(password|passcode|secret|api key|token|credential|keychain|credit card|card number|cvv|payment|purchase|buy|checkout|bank|ssn|social security|wire|transfer money|delete account|change password|2fa|otp|captcha|admin panel|bypass security)\b/.test(
      lower
    )
  ) {
    return "blocked";
  }

  if (
    /\b(submit|send|post|upload|attach|save settings|account settings|change setting|create account|sign up|login|log in|sign in|email|message|comment|reply|publish|delete|remove|trash|move files|rename files|chmod|chown|sudo|kill|install|uninstall|launchctl|deploy|commit|push|merge)\b/.test(
      lower
    )
  ) {
    return "needs_confirmation";
  }

  return "low";
};

const inferDesktopMode = (
  lower: string
): NonNullable<DeveloperTask["desktopMode"]> => {
  if (
    /\b(run (?:the )?(?:command|shell)|shell command|execute (?:the )?command|terminal command|list files|show files|ls\b|pwd\b|find\b|du\b|cat\b)\b/.test(
      lower
    )
  ) {
    return "local_shell";
  }

  if (
    /\b(chrome|browser|website|web site|url|navigate|go to|visit|google|github search|web form)\b/.test(
      lower
    ) ||
    /\b[a-z0-9-]+\.(?:com|org|net|ai|io|dev|app|co|edu|gov)\b/.test(lower)
  ) {
    return "normal_chrome";
  }

  return "full_mac";
};

const inferTargetApp = (
  utterance: string,
  lower: string,
  desktopMode: DeveloperTask["desktopMode"]
): string | undefined => {
  if (desktopMode === "local_shell") {
    return "shell";
  }

  const knownApps: Array<[RegExp, string]> = [
    [/\bchrome|browser|google\b/i, "Chrome"],
    [/\bfinder|downloads|documents|desktop|applications folder\b/i, "Finder"],
    [/\bterminal|shell\b/i, "Terminal"],
    [/\bsystem settings|settings app|system preferences\b/i, "System Settings"],
    [/\bmail\b/i, "Mail"],
    [/\bcalendar\b/i, "Calendar"],
    [/\bnotes\b/i, "Notes"],
    [/\bmessages\b/i, "Messages"],
    [/\bslack\b/i, "Slack"]
  ];

  for (const [pattern, app] of knownApps) {
    if (pattern.test(utterance)) {
      return app;
    }
  }

  const openApp = lower.match(/\b(?:open|launch|focus)\s+([a-z][a-z0-9 ]{1,60}?)(?:\s+app)?(?:[.!?]|$)/i)?.[1];

  if (openApp) {
    return titleCaseApp(openApp);
  }

  return desktopMode === "normal_chrome" ? "Chrome" : "any";
};

const inferShellCommand = (utterance: string): string | undefined => {
  const direct = utterance.match(
    /\b(?:run|execute)\s+(?:the\s+)?(?:shell\s+)?(?:command\s+)?[`"“]?(.+?)[`"”]?(?:\s+(?:on|in|from)\s+(?:my\s+)?(?:desktop|downloads|documents|home folder|home))?[.!?]?$/i
  )?.[1];

  if (direct) {
    return direct.trim();
  }

  if (/\blist files\b/i.test(utterance) || /\bshow files\b/i.test(utterance)) {
    return "ls";
  }

  return undefined;
};

const inferShellCwd = (utterance: string, lower: string): string | undefined => {
  if (/\bdesktop\b/.test(lower)) {
    return "~/Desktop";
  }

  if (/\bdownloads\b/.test(lower)) {
    return "~/Downloads";
  }

  if (/\bdocuments\b/.test(lower)) {
    return "~/Documents";
  }

  const cwd = utterance.match(/\b(?:in|from|on)\s+((?:\/|~\/)[^\s.!?]+)\b/i)?.[1];
  return cwd?.trim();
};

const titleCaseApp = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const extractUrl = (utterance: string, lower: string): string | undefined => {
  const explicit = utterance.match(/https?:\/\/[^\s"')]+/i)?.[0];

  if (explicit) {
    return normalizeUrl(explicit);
  }

  const domain = utterance.match(
    /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|org|net|ai|io|dev|app|co|edu|gov)(?:\/[^\s"')]+)?)\b/i
  )?.[1];

  if (domain) {
    return normalizeUrl(domain);
  }

  const githubSearch = lower.match(/\b(?:github|git hub)\b.*\bsearch(?: for)?\s+(.+)$/i);

  if (githubSearch?.[1]) {
    return `https://github.com/search?q=${encodeURIComponent(
      cleanSearchQuery(githubSearch[1])
    )}&type=repositories`;
  }

  const search = lower.match(/\b(?:search|google)\s+(?:for\s+)?(.+)$/i);

  if (search?.[1]) {
    return `https://www.google.com/search?q=${encodeURIComponent(
      cleanSearchQuery(search[1])
    )}`;
  }

  return undefined;
};

const normalizeUrl = (value: string): string => {
  const clean = value.replace(/[.,!?]+$/g, "");
  return /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
};

const cleanSearchQuery = (value: string): string => {
  return value.replace(/[.!?]+$/g, "").trim();
};
