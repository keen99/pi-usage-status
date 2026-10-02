import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readActiveCodexCredential } from "../src/auth.ts";
import { buildFetchTasks, type RuntimeContext } from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { ACCOUNT_STATE_TYPE } from "../src/codex-session-state.ts";

function session(name: string | null) {
  return { getBranch: () => [{ type: "custom", customType: ACCOUNT_STATE_TYPE, data: { accountName: name } }] };
}
function setup(data: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "usage-session-"));
  writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify(data));
  return dir;
}
const accounts = { teams: { access: "teams-token", accountId: "teams-id" }, plus: { access: "plus-token", accountId: "plus-id" } };

test("session selection wins over global default and legacy active", () => {
  const dir = setup({ default: "teams", active: "teams", accounts });
  try {
    assert.equal(readActiveCodexCredential(dir, session("plus"))?.accountName, "plus");
    assert.equal(readActiveCodexCredential(dir, session("teams"))?.accountName, "teams");
    assert.equal(readActiveCodexCredential(dir)?.accountName, "teams");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit built-in selection never reads named global default", () => {
  const dir = setup({ default: "teams", accounts });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { access: "builtin-token" } }));
  try {
    const selected = readActiveCodexCredential(dir, session(null));
    assert.equal(selected?.source, "pi-auth"); assert.equal(selected?.access, "builtin-token");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing explicit selection does not quietly display default or built-in", () => {
  const dir = setup({ default: "teams", accounts });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { access: "builtin-token" } }));
  try { assert.equal(readActiveCodexCredential(dir, session("missing")), undefined); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("footer tasks follow session account through model swaps", async () => {
  const dir = setup({ default: "teams", accounts });
  try {
    for (const id of ["gpt-5.6", "gpt-5.6-terra", "gpt-5.3-codex"]) {
      const ctx = { model: { provider: "openai-codex", id }, sessionManager: session("plus"),
        modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "plus-runtime" }) },
      } as unknown as RuntimeContext;
      const tasks = await buildFetchTasks(ctx, "openai-codex", { ...DEFAULT_CONFIG, codexAccountDisplay: "active" }, dir);
      assert.deepEqual(tasks.map(t => [t.key, t.label]), [["codex:plus", "Codex plus"]]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy rewrite dropping default does not change session-selected footer account", () => {
  const dir = setup({ default: "teams", active: "teams", accounts });
  try {
    assert.equal(readActiveCodexCredential(dir, session("plus"))?.accountName, "plus");
    // Legacy refresh serializer keeps active/accounts and discards default.
    writeFileSync(join(dir, "codex-accounts.json"), JSON.stringify({ active: "teams", accounts }));
    assert.equal(readActiveCodexCredential(dir, session("plus"))?.accountName, "plus");
    assert.equal(readActiveCodexCredential(dir)?.accountName, "teams");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit null default does not fall back to legacy active", () => {
  const dir = setup({ default: null, active: "teams", accounts });
  try { assert.equal(readActiveCodexCredential(dir), undefined); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
