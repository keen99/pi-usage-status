import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildFetchTasks, type RuntimeContext } from "../src/index.ts";

function fakeCodexContext(runtimeToken: string): RuntimeContext {
  return {
    model: { provider: "openai-codex" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: runtimeToken }),
    },
  } as unknown as RuntimeContext;
}

test("active managed account uses Pi runtime token and stored account id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-status-index-"));
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify({
    active: "teams",
    accounts: {
      teams: { access: "stale-disk-token", accountId: "acct-teams" },
      plus: { access: "plus-token", accountId: "acct-plus" },
    },
  }));

  const tasks = await buildFetchTasks(
    fakeCodexContext("fresh-runtime-token"),
    "openai-codex",
    { ...DEFAULT_CONFIG, color: false },
    dir,
  );
  assert.deepEqual(tasks.map((task) => [task.key, task.label]), [["codex:teams", "Codex teams"]]);

  const originalFetch = globalThis.fetch;
  let headers: Headers | undefined;
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return new Response(JSON.stringify({
      plan_type: "team",
      rate_limit: { primary_window: { used_percent: 12, reset_after_seconds: 3600 } },
    }), { status: 200 });
  };
  try {
    const snapshot = await tasks[0]!.fetch();
    assert.equal(snapshot.accountName, "teams");
    assert.equal(headers?.get("authorization"), "Bearer fresh-runtime-token");
    assert.equal(headers?.get("chatgpt-account-id"), "acct-teams");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("all-account toggle creates managed and standard auth tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-status-index-"));
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify({
    active: "teams",
    accounts: {
      teams: { access: "teams-token" },
      plus: { access: "plus-token" },
    },
  }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-codex": { access: "default-token" },
  }));

  const tasks = await buildFetchTasks(
    fakeCodexContext("runtime-token"),
    "openai-codex",
    { ...DEFAULT_CONFIG, codexAccountDisplay: "all" },
    dir,
  );
  assert.deepEqual(tasks.map((task) => task.key), ["codex:teams", "codex:plus", "codex:default"]);
});

test("deduplicates managed and standard auth for same Codex account id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-status-index-"));
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify({
    active: "teams",
    accounts: {
      teams: { access: "teams-token", accountId: "same-account" },
    },
  }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-codex": { access: "default-token", accountId: "same-account" },
  }));

  const tasks = await buildFetchTasks(
    fakeCodexContext("runtime-token"),
    "openai-codex",
    { ...DEFAULT_CONFIG, codexAccountDisplay: "all" },
    dir,
  );
  assert.deepEqual(tasks.map((task) => task.key), ["codex:teams"]);
});
