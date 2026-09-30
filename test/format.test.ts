import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatDuration, formatUsageDetails, formatUsageStatus } from "../src/format.ts";
import type { UsageSnapshot } from "../src/types.ts";

const now = 1_900_000_000_000;
const snapshot: UsageSnapshot = {
  provider: "codex",
  providerLabel: "Codex",
  accountName: "teams",
  planName: "team",
  limits: [
    { label: "5h", kind: "time", usedPercent: 32, windowSeconds: 18000, resetsAt: now + 2 * 3_600_000 + 14 * 60_000 },
    { label: "week", kind: "named", usedPercent: 84, windowSeconds: 604800, resetsAt: now + 23 * 3_600_000 },
  ],
};

test("formats readable active account status", () => {
  assert.equal(
    formatUsageStatus(snapshot, { ...DEFAULT_CONFIG, color: false }, { now }),
    "Codex teams | 5h 32% ↻ 2h14m | week 84% ↻ 23h",
  );
});

test("can show remaining percentages and hide reset times", () => {
  assert.equal(
    formatUsageStatus(snapshot, {
      ...DEFAULT_CONFIG,
      color: false,
      percentageStyle: "remaining",
      showResetTimes: false,
    }, { now }),
    "Codex teams | 5h 68% | week 16%",
  );
});

test("falls back to normalized plan label when no account name", () => {
  const noAccount = { ...snapshot, accountName: undefined, planName: "pro_lite" };
  assert.match(formatUsageStatus(noAccount, { ...DEFAULT_CONFIG, color: false }, { now }), /^Codex Pro Lite \|/);
});

test("shortens legacy tier in status but not detailed usage", () => {
  const legacy = {
    ...snapshot,
    provider: "zai" as const,
    providerLabel: "GLM",
    accountName: undefined,
    planName: "legacy_pro",
  };
  assert.match(formatUsageStatus(legacy, { ...DEFAULT_CONFIG, color: false }, { now }), /^GLM Pro-L \|/);
  assert.match(formatUsageDetails(legacy, { ...DEFAULT_CONFIG, showResetTimes: false }, now), /^GLM Legacy Pro$/m);
});

test("formats Z.AI monthly tools quota with icon and count", () => {
  const zai: UsageSnapshot = {
    provider: "zai",
    providerLabel: "GLM",
    planName: "pro",
    limits: [
      { label: "5h", kind: "named", usedPercent: 1, windowSeconds: 18000, resetsAt: now + 3 * 3_600_000 },
      { label: "tools", kind: "tools", usedPercent: 4, current: 42, total: 1000, resetsAt: now + 23 * 86_400_000 },
    ],
  };
  assert.equal(
    formatUsageStatus(zai, { ...DEFAULT_CONFIG, color: false }, { now }),
    "GLM Pro | 5h 1% ↻ 3h | 🔧 4% (42/1000) ↻ 23d",
  );
  assert.match(
    formatUsageStatus(zai, { ...DEFAULT_CONFIG, color: false, toolsLabel: "text" }, { now }),
    /\| tools 4% \(42\/1000\)/,
  );
});

test("formats detailed usage for /usage", () => {
  assert.equal(
    formatUsageDetails(snapshot, { ...DEFAULT_CONFIG, color: false, showResetTimes: false }, now),
    [
      "Codex teams (Team)",
      "",
      "  5h limit:      [██████████████░░░░░░] 68% left",
      "  Weekly limit:  [███░░░░░░░░░░░░░░░░░] 16% left",
    ].join("\n"),
  );
});

test("formats compact reset durations", () => {
  assert.equal(formatDuration(3 * 86_400_000 + 2 * 3_600_000), "3d2h");
  assert.equal(formatDuration(65 * 60_000), "1h5m");
  assert.equal(formatDuration(-1), "now");
});

test("reset cards render on matching window segments when available", () => {
  const zai: UsageSnapshot = {
    provider: "zai",
    providerLabel: "GLM",
    planName: "pro",
    resetCards: [
      { kind: "fiveHour", available: 1, nearestExpiry: now + 86_400_000 },
      { kind: "week", available: 2 },
    ],
    limits: [
      { label: "5h", kind: "named", usedPercent: 96, windowSeconds: 18000, resetsAt: now + 3_600_000 },
      { label: "week", kind: "named", usedPercent: 50, windowSeconds: 604_800, resetsAt: now + 23 * 3_600_000 },
      { label: "tools", kind: "tools", usedPercent: 4, current: 42, total: 1000 },
    ],
  };
  assert.equal(
    formatUsageStatus(zai, { ...DEFAULT_CONFIG, color: false }, { now }),
    "GLM Pro | 5h 96% ↻ 1h ♻1 | week 50% ↻ 23h ♻2 | 🔧 4% (42/1000)",
  );
  assert.match(
    formatUsageStatus(zai, { ...DEFAULT_CONFIG, color: false, showResetCards: false }, { now }),
    /^GLM Pro \| 5h 96% ↻ 1h \| week 50% ↻ 23h/,
  );
});

test("reset cards omitted from status when count is zero", () => {
  const zai: UsageSnapshot = {
    provider: "zai",
    providerLabel: "GLM",
    resetCards: [{ kind: "fiveHour", available: 0 }],
    limits: [{ label: "5h", kind: "named", usedPercent: 10, windowSeconds: 18_000 }],
  };
  assert.equal(
    formatUsageStatus(zai, { ...DEFAULT_CONFIG, color: false }, { now }),
    "GLM | 5h 10%",
  );
});

test("detailed usage lists reset cards with expiry", () => {
  const zai: UsageSnapshot = {
    provider: "zai",
    providerLabel: "GLM",
    resetCards: [
      { kind: "fiveHour", available: 1, nearestExpiry: now + 3_600_000 },
      { kind: "week", available: 0 },
    ],
    limits: [{ label: "5h", kind: "named", usedPercent: 10, windowSeconds: 18_000 }],
  };
  const details = formatUsageDetails(zai, { ...DEFAULT_CONFIG, showResetTimes: false }, now);
  assert.match(details, /^  Reset cards: 1× 5h \(exp .+\), 0× week$/m);
});
