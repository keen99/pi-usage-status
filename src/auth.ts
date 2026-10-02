import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCredential, StoredCredential } from "./types.ts";
import { restoreAccountSelection, type StateEntry } from "./codex-session-state.ts";

interface CodexAccountsFile {
  default?: unknown;
  active?: unknown;
  accounts?: unknown;
}

export function readZaiApiKey(agentDir: string): string | undefined {
  const auth = readObject(join(agentDir, "auth.json"));
  const zai = asObject(auth?.zai);
  return nonEmptyString(zai?.key) ?? nonEmptyString(zai?.access);
}

export function readActiveCodexCredential(
  agentDir: string,
  session?: { getBranch(): readonly StateEntry[] },
): CodexCredential | undefined {
  const accounts = readCodexAccounts(agentDir);
  const selection = session ? restoreAccountSelection(session.getBranch()) : undefined;
  const name = selection ? selection.accountName : accounts.active;
  if (name) {
    const credential = accounts.accounts[name];
    if (credential) return { ...credential, accountName: name, source: "codex-accounts" };
    // Missing explicit selection must never silently display another account.
    if (selection) return undefined;
  }
  return readPiAuthCodexCredential(agentDir);
}

export function readAllCodexCredentials(agentDir: string): CodexCredential[] {
  const accounts = readCodexAccounts(agentDir);
  const result: CodexCredential[] = Object.entries(accounts.accounts).map(
    ([accountName, credential]) => ({
      ...credential,
      accountName,
      source: "codex-accounts" as const,
    }),
  );
  const fallback = readPiAuthCodexCredential(agentDir);
  if (fallback) result.push(fallback);
  return result;
}

export function readCodexAccounts(agentDir: string): {
  active?: string;
  accounts: Record<string, StoredCredential>;
} {
  const raw = readObject(join(agentDir, "codex-accounts.json")) as CodexAccountsFile | undefined;
  // `active` is legacy shared default. Session selection lives in pi's session,
  // not in this credentials file. Explicit null default disables legacy fallback.
  const active = raw && Object.hasOwn(raw, "default")
    ? nonEmptyString(raw.default)
    : nonEmptyString(raw?.active);
  const rawAccounts = asObject(raw?.accounts);
  const accounts: Record<string, StoredCredential> = {};
  for (const [name, value] of Object.entries(rawAccounts ?? {})) {
    const credential = parseCredential(value);
    if (credential) accounts[name] = credential;
  }
  return active ? { active, accounts } : { accounts };
}

export function extractBearerToken(result: unknown): string | undefined {
  const auth = asObject(result);
  const headers = asObject(auth?.headers);
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "authorization" || typeof value !== "string") continue;
    const match = value.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1];
  }
  return nonEmptyString(auth?.apiKey);
}

function readPiAuthCodexCredential(agentDir: string): CodexCredential | undefined {
  const auth = readObject(join(agentDir, "auth.json"));
  const credential = parseCredential(auth?.["openai-codex"]);
  return credential ? { ...credential, source: "pi-auth" } : undefined;
}

function parseCredential(value: unknown): StoredCredential | undefined {
  const raw = asObject(value);
  const access = nonEmptyString(raw?.access);
  if (!access) return undefined;
  const refresh = nonEmptyString(raw?.refresh);
  const accountId = nonEmptyString(raw?.accountId);
  const expires = typeof raw?.expires === "number" && Number.isFinite(raw.expires) ? raw.expires : undefined;
  return {
    access,
    ...(refresh ? { refresh } : {}),
    ...(accountId ? { accountId } : {}),
    ...(expires !== undefined ? { expires } : {}),
  };
}

function readObject(file: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
