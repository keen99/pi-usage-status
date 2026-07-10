import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexCredential, StoredCredential } from "./types.ts";

interface CodexAccountsFile {
  active?: unknown;
  accounts?: unknown;
}

export function readZaiApiKey(agentDir: string): string | undefined {
  const auth = readObject(join(agentDir, "auth.json"));
  const zai = asObject(auth?.zai);
  return nonEmptyString(zai?.key) ?? nonEmptyString(zai?.access);
}

export function readActiveCodexCredential(agentDir: string): CodexCredential | undefined {
  const accounts = readCodexAccounts(agentDir);
  if (accounts.active) {
    const credential = accounts.accounts[accounts.active];
    if (credential) {
      return { ...credential, accountName: accounts.active, source: "codex-accounts" };
    }
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
  const active = nonEmptyString(raw?.active);
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
