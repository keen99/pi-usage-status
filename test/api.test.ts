import assert from "node:assert/strict";
import test from "node:test";
import { fetchCodexUsage, fetchZaiUsage } from "../src/api.ts";

function jsonFetch(data: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("parses Z.AI five-hour and weekly quota", async () => {
  const snapshot = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: jsonFetch({
      code: 200,
      data: {
        level: "legacy_pro",
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, percentage: 16, nextResetTime: 2_000_000_000_000 },
          { type: "TOKENS_LIMIT", unit: 6, percentage: 4, nextResetTime: 2_000_100_000_000 },
          { type: "TIME_LIMIT", unit: 5, percentage: 9, currentValue: 42, remaining: 958, nextResetTime: 2_001_000_000_000 },
        ],
      },
    }),
  });
  assert.equal(snapshot.providerLabel, "GLM");
  assert.equal(snapshot.planName, "legacy_pro");
  assert.deepEqual(snapshot.limits.map((limit) => [limit.label, limit.usedPercent]), [["5h", 16], ["week", 4], ["tools", 9]]);
  assert.deepEqual(snapshot.limits[2], {
    label: "tools",
    usedPercent: 9,
    current: 42,
    total: 1000,
    resetsAt: 2_001_000_000_000,
  });
});

test("parses Codex quota and account label", async () => {
  const snapshot = await fetchCodexUsage(
    { access: "token", accountId: "acct", accountName: "teams" },
    {
      timeoutMs: 1000,
      fetchFn: jsonFetch({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 32, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 15, reset_at: 2_000_000_000 },
        },
      }),
    },
  );
  assert.equal(snapshot.accountName, "teams");
  assert.equal(snapshot.planName, "team");
  assert.deepEqual(snapshot.limits.map((limit) => [limit.label, limit.usedPercent]), [["5h", 32], ["week", 15]]);
  assert.ok(snapshot.limits.every((limit) => typeof limit.resetsAt === "number"));
});

test("rejects malformed usage payloads", async () => {
  await assert.rejects(
    fetchCodexUsage({ access: "token" }, { timeoutMs: 1000, fetchFn: jsonFetch({}) }),
    /no quota windows/,
  );
});
