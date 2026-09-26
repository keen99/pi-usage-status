/**
 * OpenAI status page check (status.openai.com, public statuspage API).
 *
 * Surfaces Codex API component degradation so auth/request failures during
 * OpenAI incidents aren't misdiagnosed as local auth problems.
 *
 * Endpoints (no auth):
 *   /api/v2/components.json — component list incl. "Codex API"
 *   /api/v2/status.json     — overall page status
 *
 * 5-minute in-memory cache, 3-second timeout, fails silent.
 */

const COMPONENTS_URL = "https://status.openai.com/api/v2/components.json";
const STATUS_URL = "https://status.openai.com/api/v2/status.json";
const CODEX_COMPONENT_ID = "01KMP3KP5MGE23B80K1EK4S8PV"; // "Codex API"
const CACHE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 3000;

export interface OpenAIStatus {
	/** Component status string, e.g. "operational", "degraded_performance". */
	codexApi: string;
	/** Overall page indicator, e.g. "none", "minor", "critical". */
	overall: string;
	/** Overall description, e.g. "All Systems Operational". */
	overallDescription: string;
}

interface StatusCache {
	at: number;
	status: OpenAIStatus | undefined;
}

let cache: StatusCache | undefined;

async function fetchJson(url: string): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) return undefined;
		return await response.json();
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

export function clearOpenAIStatusCache(): void {
	cache = undefined;
}

export async function fetchOpenAIStatus(): Promise<OpenAIStatus | undefined> {
	if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.status;

	const [componentsRaw, statusRaw] = await Promise.all([
		fetchJson(COMPONENTS_URL),
		fetchJson(STATUS_URL),
	]);

	let codexApi = "";
	if (componentsRaw && typeof componentsRaw === "object") {
		const components = (componentsRaw as { components?: unknown[] }).components;
		if (Array.isArray(components)) {
			const hit = components.find(
				(c): c is { id?: string; status?: string } =>
					!!c && typeof c === "object" && (c as { id?: string }).id === CODEX_COMPONENT_ID,
			);
			if (hit?.status) codexApi = hit.status;
		}
	}

	let overall = "";
	let overallDescription = "";
	if (statusRaw && typeof statusRaw === "object") {
		const status = (statusRaw as { status?: { indicator?: string; description?: string } }).status;
		if (status?.indicator) overall = status.indicator;
		if (status?.description) overallDescription = status.description;
	}

	const result: OpenAIStatus | undefined =
		codexApi || overall
			? { codexApi: codexApi || "unknown", overall: overall || "unknown", overallDescription }
			: undefined;

	cache = { at: Date.now(), status: result };
	return result;
}

export function isOpenAIStatusTroubled(status: OpenAIStatus): boolean {
	return status.codexApi !== "operational" || (status.overall !== "none" && status.overall !== "unknown");
}
