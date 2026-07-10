import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

test("uses safe defaults without config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-status-config-"));
  assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
});

test("loads toggles and bounds polling intervals", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-status-config-"));
  writeFileSync(join(dir, "pi-usage-status.json"), JSON.stringify({
    providerDisplay: "all",
    codexAccountDisplay: "all",
    percentageStyle: "remaining",
    refreshIntervalMs: 10,
    requestTimeoutMs: 999999,
    showResetTimes: false,
    suppressCodexAccountsStatus: false,
  }));
  const config = loadConfig(dir);
  assert.equal(config.providerDisplay, "all");
  assert.equal(config.codexAccountDisplay, "all");
  assert.equal(config.percentageStyle, "remaining");
  assert.equal(config.refreshIntervalMs, 15_000);
  assert.equal(config.requestTimeoutMs, 60_000);
  assert.equal(config.showResetTimes, false);
  assert.equal(config.suppressCodexAccountsStatus, false);
});
