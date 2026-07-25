export async function fetchJson(
	url: string,
	init: RequestInit,
	options: { timeoutMs: number; fetchFn?: typeof fetch },
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const response = await (options.fetchFn ?? fetch)(url, { ...init, signal: controller.signal });
		if (!response.ok) {
			const detail = await readErrorDetail(response);
			throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${detail ? `: ${detail}` : ""}`);
		}
		return await response.json();
	} catch (error) {
		if (controller.signal.aborted) throw new Error(`Request timed out after ${options.timeoutMs}ms`);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

export function normalizeEpoch(value: number | undefined): number | undefined {
	if (value === undefined || value <= 0) return undefined;
	return value < 10_000_000_000 ? value * 1000 : value;
}

async function readErrorDetail(response: Response): Promise<string | undefined> {
	try {
		const text = await response.text();
		if (!text) return undefined;
		try {
			const parsed = JSON.parse(text) as unknown;
			if (parsed && typeof parsed === "object") {
				const obj = parsed as Record<string, unknown>;
				const inner = obj.error;
				if (inner && typeof inner === "object") {
					const msg = (inner as Record<string, unknown>).message;
					if (typeof msg === "string" && msg) return msg;
				}
				if (typeof obj.message === "string" && obj.message) return obj.message;
				if (typeof obj.detail === "string" && obj.detail) return obj.detail;
			}
			return text.slice(0, 200);
		} catch {
			return text.slice(0, 200);
		}
	} catch {
		return undefined;
	}
}

export function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Derive a short human-readable label from a window length in seconds.
 * Examples: 18000 -> "5h", 21600 -> "6h", 604800 -> "7d", 10800 -> "3h".
 */
export function windowLabel(windowSeconds: number | undefined, fallback = "limit"): string {
	if (windowSeconds === undefined || !Number.isFinite(windowSeconds) || windowSeconds <= 0) return fallback;
	const hours = windowSeconds / 3600;
	if (hours < 1) return `${Math.max(1, Math.round(windowSeconds / 60))}m`;
	if (hours < 24) {
		const rounded = Math.round(hours);
		return Number.isInteger(hours) ? `${rounded}h` : `${rounded}h`;
	}
	return `${Math.round(hours / 24)}d`;
}
