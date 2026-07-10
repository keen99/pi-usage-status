import type { UsageSnapshot, UsageStatusConfig } from "./types.ts";

export interface StatusTheme {
  fg(color: "success" | "warning" | "error" | "muted", text: string): string;
}

export function formatUsageStatus(
  snapshot: UsageSnapshot,
  config: UsageStatusConfig,
  options: { now?: number; theme?: StatusTheme; stale?: boolean } = {},
): string {
  const now = options.now ?? Date.now();
  const heading: string[] = [];
  if (config.showProviderLabel) heading.push(snapshot.providerLabel);
  if (config.showAccountName && snapshot.accountName) heading.push(snapshot.accountName);
  else if (config.showPlan && snapshot.planName) heading.push(formatPlanName(snapshot.planName));

  const parts = [heading.join(" ")].filter(Boolean);
  for (const limit of snapshot.limits) {
    const used = clampPercent(limit.usedPercent);
    const shown = config.percentageStyle === "remaining" ? 100 - used : used;
    const percent = `${Math.round(shown)}%`;
    const coloredPercent = config.color && options.theme
      ? options.theme.fg(colorForUsedPercent(used), percent)
      : percent;
    const label = limit.label === "tools"
      ? (config.toolsLabel === "icon" ? "🔧" : "tools")
      : limit.label;
    let text = `${label} ${coloredPercent}`;
    if (limit.current !== undefined && limit.total !== undefined) {
      const current = config.percentageStyle === "remaining"
        ? Math.max(0, limit.total - limit.current)
        : limit.current;
      text += ` (${formatCount(current)}/${formatCount(limit.total)})`;
    }
    if (config.showResetTimes && limit.resetsAt) text += ` ↻ ${formatDuration(limit.resetsAt - now)}`;
    parts.push(text);
  }
  const text = parts.join(" | ");
  return options.stale ? `◌ ${text}` : text;
}

export function formatUsageDetails(
  snapshot: UsageSnapshot,
  config: UsageStatusConfig,
  now = Date.now(),
): string {
  const heading = [snapshot.providerLabel];
  if (snapshot.accountName) heading.push(snapshot.accountName);
  else if (snapshot.planName) heading.push(formatPlanName(snapshot.planName));
  const title = snapshot.accountName && snapshot.planName
    ? `${heading.join(" ")} (${formatPlanName(snapshot.planName)})`
    : heading.join(" ");
  const lines = [`${title} usage`];

  for (const limit of snapshot.limits) {
    const used = clampPercent(limit.usedPercent);
    const shown = config.percentageStyle === "remaining" ? 100 - used : used;
    const qualifier = config.percentageStyle === "remaining" ? "remaining" : "used";
    const label = { "5h": "Five-hour", week: "Weekly", tools: "Tools" }[limit.label];
    let line = `${label}: ${Math.round(shown)}% ${qualifier}`;
    if (limit.current !== undefined && limit.total !== undefined) {
      const current = config.percentageStyle === "remaining"
        ? Math.max(0, limit.total - limit.current)
        : limit.current;
      line += ` (${formatCount(current)}/${formatCount(limit.total)})`;
    }
    if (config.showResetTimes && limit.resetsAt) {
      line += ` · resets in ${formatDuration(limit.resetsAt - now)}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "now";
  const totalMinutes = Math.max(1, Math.floor(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function snapshotKey(snapshot: UsageSnapshot): string {
  return `${snapshot.provider}:${snapshot.accountName ?? "default"}`;
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$|(?<=\.[0-9]*)0+$/, "");
}

function colorForUsedPercent(used: number): "success" | "warning" | "error" {
  if (used >= 90) return "error";
  if (used >= 75) return "warning";
  return "success";
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function formatPlanName(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
