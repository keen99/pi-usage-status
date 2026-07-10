import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extractBearerToken,
  readActiveCodexCredential,
  readAllCodexCredentials,
  readZaiApiKey,
} from "../src/auth.ts";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-usage-status-"));
}

test("active codex account takes priority over auth.json", () => {
  const dir = tempAgentDir();
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify({
    active: "teams",
    accounts: {
      teams: { access: "teams-token", refresh: "r1", expires: 123, accountId: "acct-teams" },
      plus: { access: "plus-token", refresh: "r2", expires: 456 },
    },
  }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    zai: { key: "zai-token" },
    "openai-codex": { access: "default-token", refresh: "r3", expires: 789 },
  }));

  assert.deepEqual(readActiveCodexCredential(dir), {
    access: "teams-token",
    refresh: "r1",
    expires: 123,
    accountId: "acct-teams",
    accountName: "teams",
    source: "codex-accounts",
  });
  assert.equal(readZaiApiKey(dir), "zai-token");
  assert.deepEqual(readAllCodexCredentials(dir).map((item) => item.accountName), ["teams", "plus", undefined]);
});

test("auth.json is codex fallback when no active managed account", () => {
  const dir = tempAgentDir();
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    "openai-codex": { access: "default-token", accountId: "default-account" },
  }));
  assert.deepEqual(readActiveCodexCredential(dir), {
    access: "default-token",
    accountId: "default-account",
    source: "pi-auth",
  });
});

test("runtime auth token extraction supports headers and apiKey", () => {
  assert.equal(extractBearerToken({ headers: { authorization: "Bearer runtime-token" } }), "runtime-token");
  assert.equal(extractBearerToken({ apiKey: "api-key-token" }), "api-key-token");
});
