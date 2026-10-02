import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { consumeCodexResetCredit, fetchCodexUsage } from "./providers/codex.ts";
import {
  consumeZaiResetCard,
  fetchZaiResetCardEntries,
  fetchZaiUsage,
  type ZaiResetCardEntry,
} from "./providers/zai.ts";
import { fetchOpenAIStatus, isOpenAIStatusTroubled } from "./providers/openai-status.ts";
import {
  extractBearerToken,
  readActiveCodexCredential,
  readAllCodexCredentials,
  readZaiApiKey,
} from "./auth.ts";
import { loadConfig } from "./config.ts";
import { formatDuration, formatUsageDetails, formatUsageStatus, snapshotKey } from "./format.ts";
import type { CodexCredential, UsageSnapshot, UsageStatusConfig } from "./types.ts";
import { ACCOUNT_CHANGED_EVENT } from "./codex-session-state.ts";

const STATUS_KEY = "usage-status";
const REPLACED_STATUS_KEYS = ["usage-bars", "codex-usage", "glm-usage"];
const CODEX_ACCOUNTS_STATUS_KEY = "codex-accounts";
const RESET_FOREGROUND = "\x1b[39m";

type ModelLike = { provider?: string } | undefined;
export type RuntimeContext = ExtensionContext & {
  modelRegistry: ExtensionContext["modelRegistry"] & {
    getApiKeyAndHeaders?: (model: NonNullable<ExtensionContext["model"]>) => Promise<unknown>;
  };
};

export default function usageStatusExtension(pi: ExtensionAPI, dependencies: { agentDir?: string } = {}): void {
  const agentDir = dependencies.agentDir ?? getAgentDir();
  let config = loadConfig(agentDir);
  // Keep the existing guarded hook for older codex-accounts versions. New
  // versions also publish the standard shared event bus notification.
  const refreshHook = () => { void refresh().catch(() => undefined); };
  (globalThis as Record<string, unknown>).__piUsageStatusRefresh = refreshHook;
  const unsubscribeAccounts = pi.events?.on(ACCOUNT_CHANGED_EVENT, () => refreshHook());
  let currentCtx: RuntimeContext | undefined;
  let currentModel: ModelLike;
  let interval: ReturnType<typeof setInterval> | undefined;
  let refreshSequence = 0;
  let refreshPromise: Promise<void> | undefined;
  let refreshQueued = false;
  const cache = new Map<string, UsageSnapshot>();

  function setStatus(value: string | undefined): void {
    try {
      currentCtx?.ui.setStatus(STATUS_KEY, value ? `| ${value} |` : undefined);
    } catch {
      // Session replacement can stale a captured context.
    }
  }

  function clearReplacedStatuses(): void {
    if (!currentCtx) return;
    try {
      for (const key of REPLACED_STATUS_KEYS) currentCtx.ui.setStatus(key, undefined);
    } catch {
      // Ignore stale context.
    }
  }

  function suppressAccountBadge(provider: string | undefined): void {
    if (!currentCtx || !config.suppressCodexAccountsStatus || provider !== "openai-codex") return;
    try {
      currentCtx.ui.setStatus(CODEX_ACCOUNTS_STATUS_KEY, undefined);
    } catch {
      // Ignore stale context.
    }
  }

  function refresh(): Promise<void> {
    refreshSequence += 1;
    if (refreshPromise) {
      refreshQueued = true;
      return refreshPromise;
    }
    refreshPromise = (async () => {
      try {
        do {
          refreshQueued = false;
          await runRefresh();
        } while (refreshQueued);
      } finally {
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  }

  async function runRefresh(): Promise<void> {
    const ctx = currentCtx;
    if (!ctx) return;
    const sequence = refreshSequence;
    const provider = currentModel?.provider ?? ctx.model?.provider;
    suppressAccountBadge(provider);

    const tasks = await buildFetchTasks(ctx, provider, config, agentDir);
    if (!tasks.length) {
      if (sequence === refreshSequence) setStatus(undefined);
      return;
    }

    // Replace the previous account label before network work. A slow quota
    // request must not leave the OLD account's usage in the footer after switch.
    if (sequence === refreshSequence && ctx === currentCtx) {
      const theme = config.color ? ctx.ui.theme : undefined;
      setStatus(tasks.map((task) => {
        const cached = cache.get(task.key);
        return cached ? formatUsageStatus(cached, config, { theme, stale: true })
          : `${task.label} | fetching usage`;
      }).join(" || "));
    }
    const results = await Promise.all(
      tasks.map(async (task) => {
        try {
          const snapshot = await task.fetch();
          cache.set(snapshotKey(snapshot), snapshot);
          return { snapshot, stale: false };
        } catch (error) {
          const cached = cache.get(task.key);
          if (cached) return { snapshot: cached, stale: true };
          return { error, label: task.label };
        }
      }),
    );
    if (sequence !== refreshSequence || ctx !== currentCtx) return;

    const theme = config.color ? ctx.ui.theme : undefined;
    const formatted = results.map((result) => {
      if ("snapshot" in result && result.snapshot) {
        return formatUsageStatus(result.snapshot, config, { theme, stale: result.stale });
      }
      return `${result.label} | usage unavailable`;
    });
    setStatus(formatted.join(" || "));
    suppressAccountBadge(provider);
  }

  function startTimer(): void {
    if (interval) return;
    interval = setInterval(() => void refresh(), config.refreshIntervalMs);
    interval.unref?.();
  }

  function stopTimer(): void {
    if (!interval) return;
    clearInterval(interval);
    interval = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    currentCtx = ctx as RuntimeContext;
    currentModel = ctx.model;
    clearReplacedStatuses();
    void refresh();
  });

  pi.on("agent_start", (_event, ctx) => {
    currentCtx = ctx as RuntimeContext;
    currentModel = ctx.model;
    startTimer();
    void refresh();
  });

  pi.on("agent_end", (_event, ctx) => {
    currentCtx = ctx as RuntimeContext;
    currentModel = ctx.model;
    stopTimer();
    void refresh();
  });

  pi.on("model_select", (event, ctx) => {
    currentCtx = ctx as RuntimeContext;
    currentModel = event.model;
    void refresh();
  });

  pi.on("session_tree", (_event, ctx) => {
    currentCtx = ctx as RuntimeContext;
    currentModel = ctx.model;
    void refresh();
  });

  pi.on("session_shutdown", () => {
    stopTimer();
    refreshSequence += 1;
    unsubscribeAccounts?.();
    if ((globalThis as Record<string, unknown>).__piUsageStatusRefresh === refreshHook) {
      delete (globalThis as Record<string, unknown>).__piUsageStatusRefresh;
    }
    setStatus(undefined);
    currentCtx = undefined;
  });

  pi.registerCommand("usage", {
    description: "Show refreshed usage for all available subscriptions",
    handler: async (args, ctx) => {
      currentCtx = ctx as RuntimeContext;
      currentModel = ctx.model;
      if (args.trim()) {
        ctx.ui.notify("Usage: /usage", "warning");
        return;
      }
      config = loadConfig(agentDir);

      const provider = currentModel?.provider ?? ctx.model?.provider;
      const allConfig: UsageStatusConfig = {
        ...config,
        providerDisplay: "all",
        codexAccountDisplay: "all",
      };
      const tasks = await buildFetchTasks(currentCtx, provider, allConfig, agentDir);
      const sections = await Promise.all(tasks.map(async (task) => {
        try {
          const snapshot = await task.fetch();
          cache.set(snapshotKey(snapshot), snapshot);
          return formatUsageDetails(snapshot, config, Date.now(), ctx.ui.theme);
        } catch {
          const cached = cache.get(task.key);
          return cached
            ? `◌ Cached\n${formatUsageDetails(cached, config, Date.now(), ctx.ui.theme)}`
            : `${task.label} usage unavailable${formatUnavailableReason(task, Date.now())}`;
        }
      }));
      if (!sections.length) {
        ctx.ui.notify("No supported provider credentials found", "warning");
        return;
      }

      const openaiStatus = await fetchOpenAIStatus();
      if (openaiStatus && isOpenAIStatusTroubled(openaiStatus)) {
        const parts = [`⚠ OpenAI status: Codex API — ${openaiStatus.codexApi}`];
        if (openaiStatus.overall !== "unknown") parts.push(`overall ${openaiStatus.overall}`);
        parts.push("status.openai.com");
        sections.unshift(parts.join(" · "));
      }

      const activeSnapshot = activeCachedSnapshot(provider);
      if (activeSnapshot) {
        setStatus(formatUsageStatus(activeSnapshot, config, {
          theme: config.color ? ctx.ui.theme : undefined,
        }));
        suppressAccountBadge(provider);
      }
      ctx.ui.notify(RESET_FOREGROUND + sections.join("\n\n"), "info");
    },
  });

  pi.registerCommand("usage-reset", {
    description: "Redeem one available usage reset (Codex accounts, or GLM reset cards — GLM path UNTESTED)",
    handler: async (args, ctx) => {
      currentCtx = ctx as RuntimeContext;
      currentModel = ctx.model;
      const accountArg = args.trim().toLowerCase();
      config = loadConfig(agentDir);

      const allConfig: UsageStatusConfig = {
        ...config,
        providerDisplay: "all",
        codexAccountDisplay: "all",
      };
      const tasks = await buildFetchTasks(currentCtx, undefined, allConfig, agentDir);

      interface RedeemOption {
        label: string;
        match: string;
        redeem: () => Promise<string>;
      }
      const options: RedeemOption[] = [];

      const codexTasks = tasks.filter((task) => task.provider === "codex");
      const codexSnapshots: Array<{ task: FetchTask; snapshot: UsageSnapshot }> = [];
      for (const task of codexTasks) {
        try {
          const snapshot = await task.fetch();
          cache.set(snapshotKey(snapshot), snapshot);
          codexSnapshots.push({ task, snapshot });
        } catch {
          // Ignore unavailable accounts for reset flow.
        }
      }
      for (const { task, snapshot } of codexSnapshots) {
        const count = (snapshot.resetCredits?.available ?? 0) > 0 || snapshot.resetCredits?.unlimited;
        if (!count) continue;
        const countBefore = formatResetCreditCount(snapshot);
        options.push({
          label: `${task.label} (${countBefore} resets)`,
          match: task.label.toLowerCase(),
          redeem: async () => {
            await task.consumeReset?.();
            const refreshed = await task.fetch();
            cache.set(snapshotKey(refreshed), refreshed);
            return `Redeemed 1 Codex usage reset for ${task.label}. ${formatResetCreditCount(refreshed)} remaining.`;
          },
        });
      }

      const zaiTask = tasks.find((task) => task.provider === "zai");
      if (zaiTask) {
        try {
          const apiKey = readZaiApiKey(agentDir) ?? "";
          const entries = (await fetchZaiResetCardEntries(apiKey, {
            timeoutMs: config.requestTimeoutMs,
          })).filter((entry) => entry.available);
          if (entries.length) {
            const summary = formatZaiCardSummary(entries);
            options.push({
              label: `GLM (${summary}) — UNTESTED`,
              match: "glm zai z.ai",
              redeem: async () => {
                const confirmed = await ctx.ui.confirm(
                  "Consume GLM reset card?",
                  `This will permanently consume 1 GLM ${summary}. ` +
                    "UNTESTED: the redeem endpoint was reverse-engineered from the z.ai console " +
                    "and has never been verified live. Cards also expire — soonest goes first.",
                );
                if (!confirmed) return "Cancelled — nothing consumed.";
                const card = soonestExpiringCard(entries);
                await consumeZaiResetCard(apiKey, card, {
                  timeoutMs: config.requestTimeoutMs,
                });
                // Console waits ~2s before refetching; server lags behind the use call.
                await new Promise((resolve) => setTimeout(resolve, 2_000));
                const refreshed = await zaiTask.fetch();
                cache.set(snapshotKey(refreshed), refreshed);
                return `Redeemed 1 GLM ${card.kind === "fiveHour" ? "5-hour" : "weekly"} reset card.`;
              },
            });
          }
        } catch {
          // GLM card inventory unavailable — skip the option.
        }
      }

      if (!options.length) {
        ctx.ui.notify("No usage resets available (Codex credits or GLM cards)", "info");
        return;
      }

      let selected = options[0];
      if (accountArg) {
        const match = options.find((option) => option.match.includes(accountArg));
        if (!match) {
          const names = options.map((option) => option.match.split(" ")[0]).join(", ");
          ctx.ui.notify(`No matching option "${args.trim()}". Available: ${names}`, "warning");
          return;
        }
        selected = match;
      } else if (options.length > 1) {
        const choice = await ctx.ui.select("Redeem which usage reset?", options.map((option) => option.label));
        if (!choice) return;
        const index = options.findIndex((option) => option.label === choice);
        selected = options[index] ?? selected;
      }

      try {
        const message = await selected.redeem();
        ctx.ui.notify(message, "info");
        const provider = currentModel?.provider ?? ctx.model?.provider;
        const activeSnapshot = activeCachedSnapshot(provider);
        if (activeSnapshot) {
          setStatus(formatUsageStatus(activeSnapshot, config, {
            theme: config.color ? ctx.ui.theme : undefined,
          }));
          suppressAccountBadge(provider);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to redeem usage reset: ${message}`, "error");
      }
    },
  });

  function activeCachedSnapshot(provider: string | undefined): UsageSnapshot | undefined {
    if (provider === "zai" || provider === "zai-1m") return cache.get("zai:default");
    if (provider !== "openai-codex") return undefined;
    const credential = readActiveCodexCredential(agentDir, currentCtx?.sessionManager);
    return cache.get(`codex:${credential?.accountName ?? "default"}`);
  }
}

interface FetchTask {
  key: string;
  label: string;
  provider: UsageSnapshot["provider"];
  fetch: () => Promise<UsageSnapshot>;
  consumeReset?: () => Promise<unknown>;
  /** When the access token expires (epoch ms), if known. Used to explain
   *  "usage unavailable" for Codex accounts whose JWT has expired. */
  tokenExpiresAt?: number;
}

export async function buildFetchTasks(
  ctx: RuntimeContext,
  activeProvider: string | undefined,
  config: UsageStatusConfig,
  agentDir: string,
): Promise<FetchTask[]> {
  const includeZai = config.providerDisplay === "all" || activeProvider === "zai" || activeProvider === "zai-1m";
  const includeCodex = config.providerDisplay === "all" || activeProvider === "openai-codex";
  const tasks: FetchTask[] = [];

  if (includeZai) {
    const key = readZaiApiKey(agentDir);
    if (key) {
      tasks.push({
        key: "zai:default",
        label: "GLM",
        provider: "zai",
        fetch: () => fetchZaiUsage(key, { timeoutMs: config.requestTimeoutMs }),
      });
    }
  }

  if (includeCodex) {
    const activeCredential = readActiveCodexCredential(agentDir, ctx.sessionManager);
    const credentials = config.codexAccountDisplay === "all"
      ? readAllCodexCredentials(agentDir)
      : [activeCredential].filter((value): value is CodexCredential => !!value);
    const runtimeToken = activeProvider === "openai-codex" ? await readRuntimeCodexToken(ctx) : undefined;

    for (const credential of deduplicateCredentials(credentials)) {
      const isActive = sameCredential(credential, activeCredential);
      const resolved = isActive && runtimeToken ? { ...credential, access: runtimeToken } : credential;
      const name = resolved.accountName;
      tasks.push({
        key: `codex:${name ?? "default"}`,
        label: name ? `Codex ${name}` : "Codex",
        provider: "codex",
        fetch: () => fetchCodexUsage(resolved, { timeoutMs: config.requestTimeoutMs }),
        consumeReset: () => consumeCodexResetCredit(resolved, { timeoutMs: config.requestTimeoutMs }),
        ...(typeof resolved.expires === "number" && Number.isFinite(resolved.expires)
          ? { tokenExpiresAt: resolved.expires }
          : {}),
      });
    }
  }

  return tasks;
}

async function readRuntimeCodexToken(ctx: RuntimeContext): Promise<string | undefined> {
  if (!ctx.model || ctx.model.provider !== "openai-codex") return undefined;
  try {
    const result = await ctx.modelRegistry.getApiKeyAndHeaders?.(ctx.model);
    const record = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
    if (record?.ok === false) return undefined;
    const token = extractBearerToken(result);
    // Fail-closed account errors deliberately inject a non-token sentinel.
    // Never use that sentinel to fetch quota or label another account's data.
    return token === "pi-codex-accounts-refresh-failed" ? undefined : token;
  } catch {
    return undefined;
  }
}

function formatUnavailableReason(task: FetchTask, now: number): string {
  if (typeof task.tokenExpiresAt !== "number" || !Number.isFinite(task.tokenExpiresAt)) return "";
  const ms = task.tokenExpiresAt - now;
  if (ms <= 0) {
    const ago = formatDuration(-ms);
    return ` (token expired ${ago} ago — run /login openai-codex)`;
  }
  const until = formatDuration(ms);
  return ` (token expires in ${until})`;
}

function formatResetCreditCount(snapshot: UsageSnapshot): string {
  return snapshot.resetCredits?.unlimited ? "unlimited" : String(snapshot.resetCredits?.available ?? 0);
}

function formatZaiCardSummary(entries: ZaiResetCardEntry[]): string {
  const parts: string[] = [];
  for (const kind of ["fiveHour", "week"] as const) {
    const count = entries.filter((entry) => entry.kind === kind).length;
    if (count > 0) parts.push(`${count}× ${kind === "fiveHour" ? "5-hour" : "weekly"} card${count > 1 ? "s" : ""}`);
  }
  return parts.join(", ") || "no cards";
}

/** Soonest-expiring available card first — matches console priority sorting. */
function soonestExpiringCard(entries: ZaiResetCardEntry[]): { kind: ZaiResetCardEntry["kind"]; recordId: number } {
  const sorted = [...entries].sort((left, right) => {
    if (left.expireTime === undefined && right.expireTime === undefined) return 0;
    if (left.expireTime === undefined) return 1;
    if (right.expireTime === undefined) return -1;
    return left.expireTime - right.expireTime;
  });
  const card = sorted[0];
  return { kind: card.kind, recordId: card.recordId };
}

function sameCredential(left: CodexCredential, right: CodexCredential | undefined): boolean {
  if (!right) return false;
  if (left.accountName || right.accountName) return left.accountName === right.accountName;
  return left.source === right.source;
}

function deduplicateCredentials(credentials: CodexCredential[]): CodexCredential[] {
  const seen = new Set<string>();
  return credentials.filter((credential) => {
    const key = credential.accountId
      ? `account:${credential.accountId}`
      : `${credential.source}:${credential.accountName ?? "default"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
