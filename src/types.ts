export type UsageProvider = "zai" | "codex";
export type DisplayMode = "active" | "all";
export type PercentageStyle = "used" | "remaining";
export type ToolsLabelStyle = "icon" | "text";

/**
 * Window kind drives display order and label resolution.
 * - "tools": count-based quota (Z.AI unit 5), never time-labelled
 * - "time": duration-based window, label derived from windowSeconds
 * - "named": provider-defined semantic label (e.g. Z.AI unit 6 "week")
 */
export type WindowKind = "tools" | "time" | "named";

export interface UsageLimit {
  /**
   * Human-readable label. For time windows this is derived from windowSeconds
   * (e.g. "5h", "7d"). For named windows the provider supplies it. For tools
   * it is always "tools".
   */
  label: string;
  kind: WindowKind;
  usedPercent: number;
  resetsAt?: number;
  current?: number;
  total?: number;
  /**
   * Authoritative window length in seconds when known. Used for sort order and
   * label derivation. Undefined for tools windows and when the provider does
   * not report a duration.
   */
  windowSeconds?: number;
}

export interface ResetCredits {
  available: number;
  unlimited?: boolean;
}

export interface UsageSnapshot {
  provider: UsageProvider;
  providerLabel: string;
  accountName?: string;
  planName?: string;
  limits: UsageLimit[];
  resetCredits?: ResetCredits;
  /** When the provider access token expires (epoch ms), if known.
   *  Codex JWTs carry exp; shown so users know when /login is needed. */
  tokenExpiresAt?: number;
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
