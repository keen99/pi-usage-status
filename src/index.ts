import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { consumeCodexResetCredit, fetchCodexUsage } from "./providers/codex.ts";
import { fetchZaiUsage } from "./providers/zai.ts";
import {
  extractBearerToken,
  readActiveCodexCredential,
  readAllCodexCredentials,
  readZaiApiKey,
} from "./auth.ts";
import { loadConfig } from "./config.ts";
import { formatUsageDetails, formatUsageStatus, snapshotKey } from "./format.ts";
import type { CodexCredential, UsageSnapshot, UsageStatusConfig } from "./types.ts";

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

export default function usageStatusExtension(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  let config = loadConfig(agentDir);
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
            : `${task.label} usage unavailable`;
        }
      }));
      if (!sections.length) {
        ctx.ui.notify("No supported provider credentials found", "warning");
        return;
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
    description: "Redeem one available Codex usage limit reset (optionally pass account name)",
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
      const tasks = (await buildFetchTasks(currentCtx, "openai-codex", allConfig, agentDir))
        .filter((task) => task.provider === "codex");
      if (!tasks.length) {
        ctx.ui.notify("No Codex credentials found", "warning");
        return;
      }

      const snapshots: Array<{ task: FetchTask; snapshot: UsageSnapshot }> = [];
      for (const task of tasks) {
        try {
          const snapshot = await task.fetch();
          cache.set(snapshotKey(snapshot), snapshot);
          snapshots.push({ task, snapshot });
        } catch {
          // Ignore unavailable accounts for reset flow.
        }
      }
      if (!snapshots.length) {
        ctx.ui.notify("Codex usage unavailable", "warning");
        return;
      }

      const available = snapshots.filter(({ snapshot }) => (snapshot.resetCredits?.available ?? 0) > 0 || snapshot.resetCredits?.unlimited);
      if (!available.length) {
        ctx.ui.notify("No Codex usage resets available", "info");
        return;
      }

      let selected = available[0];
      if (accountArg) {
        const match = available.find(({ task }) => task.label.toLowerCase().includes(accountArg));
        if (!match) {
          const names = available.map((s) => s.task.label).join(", ");
          ctx.ui.notify(`No matching Codex account "${args.trim()}". Available: ${names}`, "warning");
          return;
        }
        selected = match;
      } else if (available.length > 1) {
        const labels = available.map(({ task, snapshot }) => `${task.label} (${formatResetCreditCount(snapshot)} available)`);
        const choice = await ctx.ui.select("Redeem reset for which Codex account?", labels);
        if (!choice) return;
        const index = labels.indexOf(choice);
        selected = available[index] ?? selected;
      }

      const accountLabel = selected.task.label;
      const countBefore = formatResetCreditCount(selected.snapshot);
      const confirmed = await ctx.ui.confirm(
        "Redeem Codex usage reset?",
        `This will consume 1 usage limit reset for ${accountLabel}. Available now: ${countBefore}.`,
      );
      if (!confirmed) return;

      try {
        await selected.task.consumeReset?.();
        const snapshot = await selected.task.fetch();
        cache.set(snapshotKey(snapshot), snapshot);
        const countAfter = formatResetCreditCount(snapshot);
        ctx.ui.notify(`Redeemed 1 Codex usage reset for ${accountLabel}. ${countAfter} remaining.`, "info");
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
        ctx.ui.notify(`Failed to redeem Codex usage reset: ${message}`, "error");
      }
    },
  });

  function activeCachedSnapshot(provider: string | undefined): UsageSnapshot | undefined {
    if (provider === "zai") return cache.get("zai:default");
    if (provider !== "openai-codex") return undefined;
    const credential = readActiveCodexCredential(agentDir);
    return cache.get(`codex:${credential?.accountName ?? "default"}`);
  }
}

interface FetchTask {
  key: string;
  label: string;
  provider: UsageSnapshot["provider"];
  fetch: () => Promise<UsageSnapshot>;
  consumeReset?: () => Promise<unknown>;
}

export async function buildFetchTasks(
  ctx: RuntimeContext,
  activeProvider: string | undefined,
  config: UsageStatusConfig,
  agentDir: string,
): Promise<FetchTask[]> {
  const includeZai = config.providerDisplay === "all" || activeProvider === "zai";
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
    const activeCredential = readActiveCodexCredential(agentDir);
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
    return extractBearerToken(result);
  } catch {
    return undefined;
  }
}

function formatResetCreditCount(snapshot: UsageSnapshot): string {
  return snapshot.resetCredits?.unlimited ? "unlimited" : String(snapshot.resetCredits?.available ?? 0);
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
