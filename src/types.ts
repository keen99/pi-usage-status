export type UsageProvider = "zai" | "codex";
export type DisplayMode = "active" | "all";
export type PercentageStyle = "used" | "remaining";

export interface UsageLimit {
  label: "5h" | "week";
  usedPercent: number;
  resetsAt?: number;
}

export interface UsageSnapshot {
  provider: UsageProvider;
  providerLabel: string;
  accountName?: string;
  planName?: string;
  limits: UsageLimit[];
}

export interface UsageStatusConfig {
  providerDisplay: DisplayMode;
  codexAccountDisplay: DisplayMode;
  percentageStyle: PercentageStyle;
  refreshIntervalMs: number;
  requestTimeoutMs: number;
  showProviderLabel: boolean;
  showAccountName: boolean;
  showPlan: boolean;
  showResetTimes: boolean;
  color: boolean;
  suppressCodexAccountsStatus: boolean;
}

export interface StoredCredential {
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}

export interface CodexCredential extends StoredCredential {
  accountName?: string;
  source: "codex-accounts" | "pi-auth";
}
