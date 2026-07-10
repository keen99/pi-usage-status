export type UsageProvider = "zai" | "codex";
export type DisplayMode = "active" | "all";
export type PercentageStyle = "used" | "remaining";
export type ToolsLabelStyle = "icon" | "text";

export interface UsageLimit {
  label: "5h" | "week" | "tools";
  usedPercent: number;
  resetsAt?: number;
  current?: number;
  total?: number;
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
  toolsLabel: ToolsLabelStyle;
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
