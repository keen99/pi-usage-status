import type { UsageLimit, UsageSnapshot } from "../types.ts";
import { asObject, fetchJson, normalizeEpoch, numberValue, windowLabel } from "./shared.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

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

	const limits: UsageLimit[] = [];
	for (const window of [rateLimit.primary_window, rateLimit.secondary_window]) {
		const parsed = parseCodexWindow(window);
		if (parsed) limits.push(parsed);
	}

	if (!limits.length) throw new Error("Codex usage response has no quota windows");

	return {
		provider: "codex",
		providerLabel: "Codex",
		...(credential.accountName ? { accountName: credential.accountName } : {}),
		...(typeof root.plan_type === "string" && root.plan_type.trim()
			? { planName: root.plan_type as string }
			: {}),
		limits,
	};
}

/**
 * Parse a Codex rate-limit window. Label and sort key are derived from
 * `limit_window_seconds` when present so the display adapts to whatever
 * window the API actually returns (5h, 7d, 3h, ...).
 */
function parseCodexWindow(value: unknown): UsageLimit | undefined {
	const window = asObject(value);
	const usedPercent = numberValue(window.used_percent);
	if (usedPercent === undefined) return undefined;

	const windowSeconds = numberValue(window.limit_window_seconds);
	const resetAt = normalizeEpoch(numberValue(window.reset_at));
	const resetAfter = numberValue(window.reset_after_seconds);
	const resetsAt = resetAt ?? (resetAfter !== undefined ? Date.now() + resetAfter * 1000 : undefined);

	return {
		label: windowLabel(windowSeconds),
		kind: "time",
		usedPercent,
		...(windowSeconds !== undefined ? { windowSeconds } : {}),
		...(resetsAt ? { resetsAt } : {}),
	};
}
