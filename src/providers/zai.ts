import type { UsageLimit, UsageSnapshot } from "../types.ts";
import { asObject, fetchJson, normalizeEpoch, numberValue, stringValue } from "./shared.ts";

export const ZAI_USAGE_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

/**
 * Z.AI quota unit values observed in the wild.
 *   3 -> short token window (historically ~5h)
 *   5 -> tools / time-limit quota (count-based)
 *   6 -> weekly token window
 */
const ZAI_UNIT_SHORT_WINDOW = 3;
const ZAI_UNIT_TOOLS = 5;
const ZAI_UNIT_WEEKLY_WINDOW = 6;

/**
 * Known duration hints for Z.AI windows. The API does not report window
 * length directly, so we fall back to these constants for sort order and
 * label derivation. Values are best-known durations in seconds.
 */
const ZAI_UNIT_DURATION_SECONDS: Record<number, number> = {
	[ZAI_UNIT_SHORT_WINDOW]: 5 * 3600,
	[ZAI_UNIT_WEEKLY_WINDOW]: 7 * 24 * 3600,
};

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
		const parsed = parseZaiLimit(limit);
		if (parsed) limits.push(parsed);
	}

	if (!limits.length) throw new Error("Z.AI usage response has no supported quota windows");

	limits.sort((left, right) => zaiSortKey(left) - zaiSortKey(right));

	const reportedPlan = stringValue(body.level);
	const planName = resolveZaiPlanName(reportedPlan, limits);

	return {
		provider: "zai",
		providerLabel: "GLM",
		...(planName ? { planName } : {}),
		limits,
	};
}

function parseZaiLimit(limit: Record<string, unknown>): UsageLimit | undefined {
	const unit = numberValue(limit.unit);
	const type = stringValue(limit.type)?.toUpperCase();
	const usedPercent = numberValue(limit.percentage);
	if (usedPercent === undefined || unit === undefined) return undefined;
	const resetsAt = normalizeEpoch(numberValue(limit.nextResetTime));

	if (unit === ZAI_UNIT_TOOLS && type === "TIME_LIMIT") {
		const current = numberValue(limit.currentValue);
		const remaining = numberValue(limit.remaining);
		const reportedTotal = numberValue(limit.usage);
		const total =
			current !== undefined && remaining !== undefined ? current + remaining : reportedTotal;
		return {
			label: "tools",
			kind: "tools",
			usedPercent,
			...(resetsAt ? { resetsAt } : {}),
			...(current !== undefined ? { current } : {}),
			...(total !== undefined ? { total } : {}),
		};
	}

	if (unit === ZAI_UNIT_SHORT_WINDOW) {
		const windowSeconds = ZAI_UNIT_DURATION_SECONDS[ZAI_UNIT_SHORT_WINDOW];
		return {
			label: "5h",
			kind: "named",
			usedPercent,
			windowSeconds,
			...(resetsAt ? { resetsAt } : {}),
		};
	}

	if (unit === ZAI_UNIT_WEEKLY_WINDOW) {
		const windowSeconds = ZAI_UNIT_DURATION_SECONDS[ZAI_UNIT_WEEKLY_WINDOW];
		return {
			label: "week",
			kind: "named",
			usedPercent,
			windowSeconds,
			...(resetsAt ? { resetsAt } : {}),
		};
	}

	return undefined;
}

/**
 * Z.AI "legacy" plans (lite/pro/max) historically exposed a short 5h window
 * plus a tools window but no weekly window. The API still reports those tier
 * names for grandfathered accounts. Tag them so the UI can render "Pro-L" etc.
 * Non-legacy plans (with a weekly window, or unrecognized level) pass through.
 */
function resolveZaiPlanName(reportedPlan: string | undefined, limits: UsageLimit[]): string | undefined {
	if (!reportedPlan) return undefined;
	const normalized = reportedPlan.toLowerCase();
	const isLegacyTier = ["lite", "pro", "max"].includes(normalized);
	if (!isLegacyTier) return reportedPlan;

	const hasShortWindow = limits.some((limit) => limit.kind === "named" && limit.label === "5h");
	const hasTools = limits.some((limit) => limit.kind === "tools");
	const hasWeek = limits.some((limit) => limit.kind === "named" && limit.label === "week");
	const inferredLegacy = hasShortWindow && hasTools && !hasWeek;
	return inferredLegacy ? `legacy_${normalized}` : reportedPlan;
}

/**
 * Sort order: short windows first, then weekly, then tools last. Uses
 * windowSeconds when available for a stable cross-provider ordering.
 */
function zaiSortKey(limit: UsageLimit): number {
	if (limit.kind === "tools") return 100;
	if (limit.label === "week") return 50;
	if (limit.label === "5h") return 10;
	return limit.windowSeconds ?? 999;
}
