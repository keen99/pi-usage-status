import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { formatDuration, formatUsageStatus } from "../src/format.ts";
import type { UsageSnapshot } from "../src/types.ts";

const now = 1_900_000_000_000;
const snapshot: UsageSnapshot = {
  provider: "codex",
  providerLabel: "Codex",
  accountName: "teams",
  planName: "team",
  limits: [
    { label: "5h", usedPercent: 32, resetsAt: now + 2 * 3_600_000 + 14 * 60_000 },
    { label: "week", usedPercent: 84, resetsAt: now + 23 * 3_600_000 },
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

test("formats compact reset durations", () => {
  assert.equal(formatDuration(3 * 86_400_000 + 2 * 3_600_000), "3d2h");
  assert.equal(formatDuration(65 * 60_000), "1h5m");
  assert.equal(formatDuration(-1), "now");
});
