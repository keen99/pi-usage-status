import assert from "node:assert/strict";
import test from "node:test";
import { fetchCodexUsage } from "../src/providers/codex.ts";
import { fetchZaiUsage } from "../src/providers/zai.ts";

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
        level: "pro",
        limits: [
          { type: "TOKENS_LIMIT", unit: 3, percentage: 16, nextResetTime: 2_000_000_000_000 },
          { type: "TOKENS_LIMIT", unit: 6, percentage: 4, nextResetTime: 2_000_100_000_000 },
          { type: "TIME_LIMIT", unit: 5, percentage: 9, currentValue: 42, remaining: 958, nextResetTime: 2_001_000_000_000 },
        ],
      },
    }),
  });
  assert.equal(snapshot.providerLabel, "GLM");
  assert.equal(snapshot.planName, "pro");
  assert.deepEqual(
    snapshot.limits.map((limit) => [limit.label, limit.kind, limit.usedPercent]),
    [["5h", "named", 16], ["week", "named", 4], ["tools", "tools", 9]],
  );
  assert.deepEqual(snapshot.limits[2], {
    label: "tools",
    kind: "tools",
    usedPercent: 9,
    current: 42,
    total: 1000,
    resetsAt: 2_001_000_000_000,
  });
});

test("infers legacy Lite, Pro, and Max from Z.AI quota shape", async () => {
  for (const tier of ["lite", "pro", "max"] as const) {
    const snapshot = await fetchZaiUsage("key", {
      timeoutMs: 1000,
      fetchFn: jsonFetch({
        code: 200,
        data: {
          level: tier,
          limits: [
            { type: "TIME_LIMIT", unit: 5, percentage: 4, currentValue: 42, remaining: 958 },
            { type: "TOKENS_LIMIT", unit: 3, percentage: 1 },
          ],
        },
      }),
    });
    assert.equal(snapshot.planName, `legacy_${tier}`);
    assert.deepEqual(snapshot.limits.map((limit) => [limit.label, limit.kind]), [["5h", "named"], ["tools", "tools"]]);
  }
});

test("parses Codex quota with dynamic window labels", async () => {
  const snapshot = await fetchCodexUsage(
    { access: "token", accountId: "acct", accountName: "teams" },
    {
      timeoutMs: 1000,
      fetchFn: jsonFetch({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 32, limit_window_seconds: 18000, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_at: 2_000_000_000 },
        },
      }),
    },
  );
  assert.equal(snapshot.accountName, "teams");
  assert.equal(snapshot.planName, "team");
  assert.deepEqual(
    snapshot.limits.map((limit) => [limit.label, limit.kind, limit.usedPercent]),
    [["5h", "time", 32], ["7d", "time", 15]],
  );
  assert.ok(snapshot.limits.every((limit) => typeof limit.resetsAt === "number"));
  assert.equal(snapshot.limits[0].windowSeconds, 18000);
  assert.equal(snapshot.limits[1].windowSeconds, 604800);
});

test("adapts when Codex collapses to a single weekly window", async () => {
  const snapshot = await fetchCodexUsage(
    { access: "token", accountId: "acct", accountName: "teams" },
    {
      timeoutMs: 1000,
      fetchFn: jsonFetch({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 4, limit_window_seconds: 604800, reset_after_seconds: 593553 },
          secondary_window: null,
        },
      }),
    },
  );
  assert.deepEqual(
    snapshot.limits.map((limit) => [limit.label, limit.kind, limit.usedPercent]),
    [["7d", "time", 4]],
  );
});

test("falls back to generic label when Codex omits window duration", async () => {
  const snapshot = await fetchCodexUsage(
    { access: "token" },
    {
      timeoutMs: 1000,
      fetchFn: jsonFetch({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 32, reset_after_seconds: 3600 },
        },
      }),
    },
  );
  assert.equal(snapshot.limits.length, 1);
  assert.equal(snapshot.limits[0].label, "limit");
});

test("rejects malformed usage payloads", async () => {
  await assert.rejects(
    fetchCodexUsage({ access: "token" }, { timeoutMs: 1000, fetchFn: jsonFetch({}) }),
    /no quota windows/,
  );
});
