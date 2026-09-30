import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_RESET_CONSUME_URL, consumeCodexResetCredit, fetchCodexUsage } from "../src/providers/codex.ts";
import { fetchZaiUsage } from "../src/providers/zai.ts";

function jsonFetch(data: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Route by URL so one fetchFn serves both the quota and subscription endpoints. */
function routingFetch(map: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (!(url in map)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(map[url]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const V2_SHAPE_QUOTA = {
  code: 200,
  data: {
    level: "pro",
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 16 },
      { type: "TOKENS_LIMIT", unit: 6, number: 7, percentage: 4 },
      { type: "TIME_LIMIT", unit: 5, percentage: 9, currentValue: 42, remaining: 958 },
    ],
  },
};

test("subscription version V3 labels the credits plan", async () => {
  const snapshot = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: routingFetch({
      "https://api.z.ai/api/monitor/usage/quota/limit": V2_SHAPE_QUOTA,
      "https://api.z.ai/api/biz/subscription/list": {
        code: 200,
        data: [
          { version: "V3", productName: "GLM Coding Pro", status: "VALID", inCurrentPeriod: true },
        ],
      },
    }),
  });
  assert.equal(snapshot.planName, "v3_pro");
});

test("subscription version V1 agrees with legacy inference", async () => {
  const snapshot = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: routingFetch({
      "https://api.z.ai/api/monitor/usage/quota/limit": {
        code: 200,
        data: {
          level: "pro",
          limits: [
            { type: "TIME_LIMIT", unit: 5, percentage: 4, currentValue: 42, remaining: 958 },
            { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1 },
          ],
        },
      },
      "https://api.z.ai/api/biz/subscription/list": {
        code: 200,
        data: [
          { version: "V1", productName: "GLM Coding Pro", status: "VALID", inCurrentPeriod: true },
          { version: "V2", productName: "GLM Coding Pro", status: "VALID", inCurrentPeriod: false },
        ],
      },
    }),
  });
  assert.equal(snapshot.planName, "legacy_pro");
});

test("subscription endpoint failure falls back to quota-shape inference", async () => {
  const snapshot = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: routingFetch({
      "https://api.z.ai/api/monitor/usage/quota/limit": V2_SHAPE_QUOTA,
    }),
  });
  assert.equal(snapshot.planName, "pro");
});

test("unknown TOKENS_LIMIT unit renders generically via number-hours", async () => {
  const snapshot = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: routingFetch({
      "https://api.z.ai/api/monitor/usage/quota/limit": {
        code: 200,
        data: {
          level: "pro",
          limits: [
            { type: "TOKENS_LIMIT", unit: 9, number: 5, percentage: 42, nextResetTime: 2_000_000_000_000 },
            { type: "TIME_LIMIT", unit: 5, percentage: 9, currentValue: 42, remaining: 958 },
          ],
        },
      },
    }),
  });
  assert.deepEqual(
    snapshot.limits.map((limit) => [limit.label, limit.kind, limit.usedPercent]),
    [["5h", "named", 42], ["tools", "tools", 9]],
  );
  assert.equal(snapshot.limits[0].windowSeconds, 18000);
});

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

test("parses Codex reset credits", async () => {
  const snapshot = await fetchCodexUsage(
    { access: "token" },
    {
      timeoutMs: 1000,
      fetchFn: jsonFetch({
        plan_type: "team",
        rate_limit: {
          primary_window: { used_percent: 32, limit_window_seconds: 18000 },
        },
        rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
      }),
    },
  );
  assert.deepEqual(snapshot.resetCredits, { available: 3 });
});

test("consumes Codex reset credit with account header", async () => {
  let url = "";
  let method = "";
  let headers: Headers | undefined;
  let body = "";
  await consumeCodexResetCredit(
    { access: "token", accountId: "acct" },
    {
      timeoutMs: 1000,
      fetchFn: async (input, init) => {
        url = String(input);
        method = init?.method ?? "GET";
        headers = new Headers(init?.headers);
        body = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  );
  assert.equal(url, CODEX_RESET_CONSUME_URL);
  assert.equal(method, "POST");
  assert.equal(headers?.get("authorization"), "Bearer token");
  assert.equal(headers?.get("chatgpt-account-id"), "acct");
  assert.match(body, /^\{"redeem_request_id":"[0-9a-f-]+"\}$/);
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

const RESET_CARDS_URL = "https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL";

test("Z.AI reset cards parsed with availability and nearest expiry", async () => {
  const snapshot = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: routingFetch({
      "https://api.z.ai/api/monitor/usage/quota/limit": V2_SHAPE_QUOTA,
      [RESET_CARDS_URL]: {
        code: 200,
        data: {
          fiveHourResets: [
            { recordId: 1, expireTime: "2026-10-05 23:59:59", available: true },
            { recordId: 2, expireTime: "2026-10-01 23:59:59", available: true },
            { recordId: 3, expireTime: "2026-09-01 23:59:59", available: false },
          ],
          weekResets: [{ recordId: 4, expireTime: "2026-10-28 23:59:59", available: true }],
        },
      },
    }),
  });
  assert.deepEqual(snapshot.resetCards, [
    { kind: "fiveHour", available: 2, nearestExpiry: Date.parse("2026-10-01T23:59:59+08:00") },
    { kind: "week", available: 1, nearestExpiry: Date.parse("2026-10-28T23:59:59+08:00") },
  ]);
});

test("reset cards omitted when none available or endpoint fails", async () => {
  const none = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: routingFetch({
      "https://api.z.ai/api/monitor/usage/quota/limit": V2_SHAPE_QUOTA,
      [RESET_CARDS_URL]: { code: 200, data: { fiveHourResets: [], weekResets: [] } },
    }),
  });
  assert.equal(none.resetCards, undefined);

  const failed = await fetchZaiUsage("key", {
    timeoutMs: 1000,
    fetchFn: routingFetch({
      "https://api.z.ai/api/monitor/usage/quota/limit": V2_SHAPE_QUOTA,
    }),
  });
  assert.equal(failed.resetCards, undefined);
});

test("reset card inventory entries parsed with recordIds", async () => {
  const { fetchZaiResetCardEntries } = await import("../src/providers/zai.ts");
  const entries = await fetchZaiResetCardEntries("key", {
    timeoutMs: 1000,
    fetchFn: jsonFetch({
      code: 200,
      data: {
        fiveHourResets: [
          { recordId: 11, expireTime: "2026-10-01 23:59:59", available: true },
          { recordId: 12, expireTime: "2026-09-01 23:59:59", available: false },
          { recordId: "bad", expireTime: "", available: true },
        ],
        weekResets: [{ recordId: 21, expireTime: "2026-10-28 23:59:59", available: true }],
      },
    }),
  });
  assert.deepEqual(entries, [
    { kind: "fiveHour", recordId: 11, expireTime: Date.parse("2026-10-01T23:59:59+08:00"), available: true },
    { kind: "fiveHour", recordId: 12, expireTime: Date.parse("2026-09-01T23:59:59+08:00"), available: false },
    { kind: "week", recordId: 21, expireTime: Date.parse("2026-10-28T23:59:59+08:00"), available: true },
  ]);
});

test("reset card inventory throws on business error", async () => {
  const { fetchZaiResetCardEntries } = await import("../src/providers/zai.ts");
  await assert.rejects(
    fetchZaiResetCardEntries("key", {
      timeoutMs: 1000,
      fetchFn: jsonFetch({ code: 401, msg: "unauthorized" }),
    }),
    /unauthorized/,
  );
});

test("consume reset card posts expected payload (mocked only — UNTESTED live)", async () => {
  const { consumeZaiResetCard, ZAI_RESET_CARD_USE_URL } = await import("../src/providers/zai.ts");
  let seen: { url: string; init: RequestInit } | undefined;
  const captureFetch = (data: unknown): typeof fetch => async (input, init) => {
    seen = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
  };
  await consumeZaiResetCard(
    "key",
    { kind: "fiveHour", recordId: 352383 },
    { timeoutMs: 1000, fetchFn: captureFetch({ code: 200, success: true, msg: "ok" }), requestId: "req-fixed" },
  );
  assert.equal(seen?.url, ZAI_RESET_CARD_USE_URL);
  assert.equal(seen?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(seen?.init.body)), {
    targetType: "PERSONAL",
    resetType: "FIVE_HOUR",
    recordId: 352383,
    requestId: "req-fixed",
  });

  await consumeZaiResetCard(
    "key",
    { kind: "week", recordId: 21 },
    { timeoutMs: 1000, fetchFn: captureFetch({ code: 200, success: true }) },
  );
  const body = JSON.parse(String(seen?.init.body));
  assert.equal(body.resetType, "WEEK");
  assert.match(body.requestId, /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|reset-\d+-[0-9a-f]+)$/);
});

test("consume reset card throws on business failure with msg", async () => {
  const { consumeZaiResetCard } = await import("../src/providers/zai.ts");
  await assert.rejects(
    consumeZaiResetCard("key", { kind: "fiveHour", recordId: 1 }, {
      timeoutMs: 1000,
      fetchFn: jsonFetch({ code: 500, msg: "card already used", success: false }),
    }),
    /card already used/,
  );
  await assert.rejects(
    consumeZaiResetCard("key", { kind: "fiveHour", recordId: 1 }, {
      timeoutMs: 1000,
      fetchFn: jsonFetch({ code: 200, success: false }),
    }),
    /reset card use/,
  );
});
