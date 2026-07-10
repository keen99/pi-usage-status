import type { UsageSnapshot, UsageStatusConfig } from "./types.ts";

export interface StatusTheme {
  fg(
    color: "success" | "warning" | "error" | "muted" | "dim" | "accent" | "text",
    text: string,
  ): string;
}

export interface DetailTheme extends StatusTheme {
  bold(text: string): string;
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
  else if (config.showPlan && snapshot.planName) heading.push(formatStatusPlanName(snapshot.planName));

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
  theme?: DetailTheme,
): string {
  const heading = [snapshot.providerLabel];
  if (snapshot.accountName) heading.push(snapshot.accountName);
  else if (snapshot.planName) heading.push(formatPlanName(snapshot.planName));
  const title = snapshot.accountName && snapshot.planName
    ? `${heading.join(" ")} (${formatPlanName(snapshot.planName)})`
    : heading.join(" ");
  const styledTitle = theme ? theme.fg("accent", theme.bold(title)) : title;
  const lines = [styledTitle, ""];

  for (const limit of snapshot.limits) {
    const remaining = 100 - clampPercent(limit.usedPercent);
    const rawLabel = {
      "5h": "5h limit:",
      week: "Weekly limit:",
      tools: "Tools limit:",
    }[limit.label].padEnd(15);
    const label = theme ? theme.fg("muted", rawLabel) : rawLabel;
    const remainingText = `${Math.round(remaining)}% left`;
    let details = `${progressBar(remaining, theme)} ${theme
      ? theme.fg(colorForRemainingPercent(remaining), remainingText)
      : remainingText}`;
    if (limit.current !== undefined && limit.total !== undefined) {
      const count = `(${formatCount(Math.max(0, limit.total - limit.current))}/${formatCount(limit.total)} left)`;
      details += ` ${theme ? theme.fg("text", count) : count}`;
    }
    if (config.showResetTimes && limit.resetsAt) {
      const reset = `(resets ${formatResetAt(limit.resetsAt, now)})`;
      details += ` ${theme ? theme.fg("dim", reset) : reset}`;
    }
    lines.push(`  ${label}${details}`);
  }
  return lines.join("\n");
}

function progressBar(percentRemaining: number, theme?: DetailTheme): string {
  const width = 20;
  const filled = Math.round((clampPercent(percentRemaining) / 100) * width);
  const full = "█".repeat(filled);
  const empty = "░".repeat(width - filled);
  if (!theme) return `[${full}${empty}]`;
  return `[${theme.fg(colorForRemainingPercent(percentRemaining), full)}${theme.fg("dim", empty)}]`;
}

function formatResetAt(timestamp: number, nowTimestamp: number): string {
  const reset = new Date(timestamp);
  const now = new Date(nowTimestamp);
  if (!Number.isFinite(reset.getTime())) return "unknown";
  const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
  if (reset.toDateString() === now.toDateString()) return time;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${time} on ${reset.getDate()} ${months[reset.getMonth()]}`;
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

function colorForRemainingPercent(remaining: number): "success" | "warning" | "error" {
  if (remaining <= 10) return "error";
  if (remaining <= 25) return "warning";
  return "success";
}

function colorForUsedPercent(used: number): "success" | "warning" | "error" {
  if (used >= 90) return "error";
  if (used >= 75) return "warning";
  return "success";
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function formatStatusPlanName(value: string): string {
  const legacyTier = value.toLowerCase().match(/^legacy_(lite|pro|max)$/)?.[1];
  if (legacyTier) return `${legacyTier.charAt(0).toUpperCase()}${legacyTier.slice(1)}-L`;
  return formatPlanName(value);
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
