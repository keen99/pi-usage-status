import type { UsageLimit, UsageSnapshot } from "./types.ts";

export const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export async function fetchZaiUsage(
  apiKey: string,
  options: { timeoutMs: number; fetchFn?: typeof fetch },
): Promise<UsageSnapshot> {
  const data = await fetchJson(
    ZAI_USAGE_URL,
    { headers: { Authorization: `Bearer ${apiKey}` } },
    options,
  );
  const root = asObject(data);
  if (numberValue(root.code) !== 200) throw new Error(`Z.AI usage API returned code ${String(root.code)}`);
  const body = asObject(root.data);
  if (!Array.isArray(body.limits)) throw new Error("Z.AI usage response missing limits");

  const limits: UsageLimit[] = [];
  for (const value of body.limits) {
    const limit = asObject(value);
    const unit = numberValue(limit.unit);
    const type = stringValue(limit.type)?.toUpperCase();
    const usedPercent = numberValue(limit.percentage);
    if (usedPercent === undefined) continue;
    const resetsAt = normalizeEpoch(numberValue(limit.nextResetTime));

    if (unit === 3 || unit === 6) {
      limits.push({
        label: unit === 3 ? "5h" : "week",
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
      });
      continue;
    }

    if (unit === 5 && type === "TIME_LIMIT") {
      const current = numberValue(limit.currentValue);
      const remaining = numberValue(limit.remaining);
      const reportedTotal = numberValue(limit.usage);
      const total = current !== undefined && remaining !== undefined
        ? current + remaining
        : reportedTotal;
      limits.push({
        label: "tools",
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(current !== undefined ? { current } : {}),
        ...(total !== undefined ? { total } : {}),
      });
    }
  }
  limits.sort((left, right) => quotaOrder(left.label) - quotaOrder(right.label));
  if (!limits.length) throw new Error("Z.AI usage response has no supported quota windows");

  const reportedPlan = stringValue(body.level);
  const normalizedPlan = reportedPlan?.toLowerCase();
  const inferredLegacyTier = normalizedPlan !== undefined
    && ["lite", "pro", "max"].includes(normalizedPlan)
    && limits.some((limit) => limit.label === "5h")
    && limits.some((limit) => limit.label === "tools")
    && !limits.some((limit) => limit.label === "week");

  return {
    provider: "zai",
    providerLabel: "GLM",
    planName: inferredLegacyTier ? `legacy_${normalizedPlan}` : reportedPlan,
    limits,
  };
}

export async function fetchCodexUsage(
  credential: { access: string; accountId?: string; accountName?: string },
  options: { timeoutMs: number; fetchFn?: typeof fetch },
): Promise<UsageSnapshot> {
  const headers: Record<string, string> = {
    accept: "application/json",
    Authorization: `Bearer ${credential.access}`,
  };
  if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
  const data = await fetchJson(CODEX_USAGE_URL, { headers }, options);
  const root = asObject(data);
  const rateLimit = asObject(root.rate_limit ?? data);
  const limits = [
    parseCodexWindow("5h", rateLimit.primary_window),
    parseCodexWindow("week", rateLimit.secondary_window),
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (!limits.length) throw new Error("Codex usage response has no quota windows");

  return {
    provider: "codex",
    providerLabel: "Codex",
    ...(credential.accountName ? { accountName: credential.accountName } : {}),
    ...(stringValue(root.plan_type) ? { planName: stringValue(root.plan_type) } : {}),
    limits,
  };
}

function quotaOrder(label: UsageLimit["label"]): number {
  return { "5h": 0, week: 1, tools: 2 }[label];
}

function parseCodexWindow(label: "5h" | "week", value: unknown) {
  const window = asObject(value);
  const usedPercent = numberValue(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const resetAt = normalizeEpoch(numberValue(window.reset_at));
  const resetAfter = numberValue(window.reset_after_seconds);
  const resetsAt = resetAt ?? (resetAfter !== undefined ? Date.now() + resetAfter * 1000 : undefined);
  return { label, usedPercent, ...(resetsAt ? { resetsAt } : {}) };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; fetchFn?: typeof fetch },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetchFn ?? fetch)(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Request timed out after ${options.timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEpoch(value: number | undefined): number | undefined {
  if (value === undefined || value <= 0) return undefined;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
