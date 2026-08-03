import type { ResetCredits, UsageLimit, UsageSnapshot } from "../types.ts";
import { asObject, fetchJson, normalizeEpoch, numberValue, windowLabel } from "./shared.ts";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

export async function fetchCodexUsage(
	credential: { access: string; accountId?: string; accountName?: string; expires?: number },
	options: { timeoutMs: number; fetchFn?: typeof fetch },
): Promise<UsageSnapshot> {
	const data = await fetchJson(CODEX_USAGE_URL, { headers: codexHeaders(credential) }, options);
	const root = asObject(data);
	const rateLimit = asObject(root.rate_limit ?? data);

	const limits: UsageLimit[] = [];
	for (const window of [rateLimit.primary_window, rateLimit.secondary_window]) {
		const parsed = parseCodexWindow(window);
		if (parsed) limits.push(parsed);
	}

	if (!limits.length) throw new Error("Codex usage response has no quota windows");

	const resetCredits = parseResetCredits(root);

	return {
		provider: "codex",
		providerLabel: "Codex",
		...(credential.accountName ? { accountName: credential.accountName } : {}),
		...(typeof root.plan_type === "string" && root.plan_type.trim()
			? { planName: root.plan_type as string }
			: {}),
		limits,
		...(resetCredits ? { resetCredits } : {}),
		...(typeof credential.expires === "number" && Number.isFinite(credential.expires)
			? { tokenExpiresAt: credential.expires }
			: {}),
	};
}

export async function consumeCodexResetCredit(
	credential: { access: string; accountId?: string },
	options: { timeoutMs: number; fetchFn?: typeof fetch },
): Promise<unknown> {
	return await fetchJson(CODEX_RESET_CONSUME_URL, {
		method: "POST",
		headers: codexHeaders(credential, { "content-type": "application/json" }),
		body: JSON.stringify({ redeem_request_id: crypto.randomUUID() }),
	}, options);
}

function codexHeaders(
	credential: { access: string; accountId?: string },
	extra: Record<string, string> = {},
): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		Authorization: `Bearer ${credential.access}`,
		...extra,
	};
	if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
	return headers;
}

function parseResetCredits(root: Record<string, unknown>): ResetCredits | undefined {
	const candidates = [
		root.rate_limit_reset_credits,
		root.rate_limit_reset_credit,
		root.reset_credits,
		root.credits,
		asObject(root.rate_limit).credits,
	];
	for (const candidate of candidates) {
		const parsed = parseResetCreditValue(candidate);
		if (parsed) return parsed;
	}
	return undefined;
}

function parseResetCreditValue(value: unknown): ResetCredits | undefined {
	const number = numberValue(value);
	if (number !== undefined) return { available: Math.max(0, Math.floor(number)) };
	const object = asObject(value);
	const balance = numberValue(object.available_count)
		?? numberValue(object.applicable_available_count)
		?? numberValue(object.balance)
		?? numberValue(object.available)
		?? numberValue(object.remaining)
		?? numberValue(object.count);
	if (balance === undefined) return undefined;
	return {
		available: Math.max(0, Math.floor(balance)),
		...(object.unlimited === true ? { unlimited: true } : {}),
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
