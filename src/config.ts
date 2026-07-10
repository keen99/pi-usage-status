import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageStatusConfig } from "./types.ts";

export const CONFIG_FILE = "pi-usage-status.json";

export const DEFAULT_CONFIG: UsageStatusConfig = {
  providerDisplay: "active",
  codexAccountDisplay: "active",
  percentageStyle: "used",
  toolsLabel: "icon",
  refreshIntervalMs: 60_000,
  requestTimeoutMs: 5_000,
  showProviderLabel: true,
  showAccountName: true,
  showPlan: true,
  showResetTimes: true,
  color: true,
  suppressCodexAccountsStatus: true,
};

export function loadConfig(agentDir: string): UsageStatusConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE), "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONFIG };
  const raw = value as Record<string, unknown>;
  return {
    providerDisplay: raw.providerDisplay === "all" ? "all" : "active",
    codexAccountDisplay: raw.codexAccountDisplay === "all" ? "all" : "active",
    percentageStyle: raw.percentageStyle === "remaining" ? "remaining" : "used",
    toolsLabel: raw.toolsLabel === "text" ? "text" : "icon",
    refreshIntervalMs: boundedNumber(raw.refreshIntervalMs, DEFAULT_CONFIG.refreshIntervalMs, 15_000, 3_600_000),
    requestTimeoutMs: boundedNumber(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 1_000, 60_000),
    showProviderLabel: booleanValue(raw.showProviderLabel, DEFAULT_CONFIG.showProviderLabel),
    showAccountName: booleanValue(raw.showAccountName, DEFAULT_CONFIG.showAccountName),
    showPlan: booleanValue(raw.showPlan, DEFAULT_CONFIG.showPlan),
    showResetTimes: booleanValue(raw.showResetTimes, DEFAULT_CONFIG.showResetTimes),
    color: booleanValue(raw.color, DEFAULT_CONFIG.color),
    suppressCodexAccountsStatus: booleanValue(
      raw.suppressCodexAccountsStatus,
      DEFAULT_CONFIG.suppressCodexAccountsStatus,
    ),
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}
