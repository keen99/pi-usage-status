# pi-usage-status

![CI](https://github.com/keen99/pi-usage-status/actions/workflows/ci.yml/badge.svg)
![release-watch](https://github.com/keen99/pi-usage-status/actions/workflows/release-watch.yml/badge.svg)
[![pi tested](https://img.shields.io/github/v/release/keen99/pi-usage-status?label=pi%20tested%200.75.0%20%E2%86%92)](https://github.com/keen99/pi-usage-status/releases)

Readable subscription quota status for [pi](https://github.com/earendil-works/pi-mono).
Shows only the active model provider by default.

```text
| GLM Pro-L | 5h 1% ↻ 3h44m ♻1 | 🔧 4% (42/1000) ↻ 23d |
| Codex teams | 5h 32% ↻ 1h45m | week 84% ↻ 23h |
| Codex Plus | 5h 8% ↻ 4h | week 2% ↻ 6d |
```

## Providers

### Z.AI / GLM

Reads `zai.key` (or `zai.access`) from `~/.pi/agent/auth.json` and sends it only to:

```text
https://api.z.ai/api/monitor/usage/quota/limit
https://api.z.ai/api/biz/subscription/list
https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL
```

Displays quota windows actually returned by Z.AI: five-hour tokens, weekly tokens when present, and monthly tool usage (`🔧`).

Reset cards (`♻N`, Z.AI's consumable weekly/five-hour quota resets) render on their matching window segment when available; `/usage` lists counts with soonest expiry.

Redeem via `/usage-reset glm` — **UNTESTED**: the redeem endpoint (`customer-package-reset/use`) was reverse-engineered from the z.ai console bundle and never verified live. Command warns before consuming; card choice = soonest-expiring first. Codex credit redemption in the same command remains as previously shipped.

Plan generation comes from `api.z.ai/api/biz/subscription/list` (queried in parallel, best-effort): the active `VALID` + `inCurrentPeriod` subscription's `version` field labels the plan. Z.AI generations: **V1** (2025 legacy prompts), **V2** (April 2026 prompt quotas), **V3** (2026-07-30 credits-based). Labels render `Pro-L` (V1 legacy), `V2 Pro`, `V3 Pro`. If the subscription endpoint fails, plan generation falls back to quota-shape inference: Z.AI reports legacy tiers as plain `lite`, `pro`, or `max`; when five-hour and tools quotas exist but weekly quota is absent, extension labels tier `Legacy Lite`, `Legacy Pro`, or `Legacy Max` as documented inference. Unknown quota units (possible under the V3 credits plan) still render generically with percentage + reset instead of disappearing.

### OpenAI Codex

Credential priority:

1. Active account in `~/.pi/agent/codex-accounts.json`, as managed by `@narumitw/pi-codex-accounts`
2. Standard Pi login at `openai-codex` in `~/.pi/agent/auth.json`

For managed accounts, account name becomes label (`Codex teams`). For standard Pi auth, plan returned by OpenAI becomes label (`Codex Plus`). Runtime auth from Pi is preferred for active account so refreshed tokens and account switches are followed.

Credentials are sent only to:

```text
https://chatgpt.com/backend-api/wham/usage
```

This endpoint is read-only but undocumented and may change.

### OpenCode Zen

Not supported. Zen currently exposes no balance or quota API. Free models also have no queryable usage status.

## Install

```bash
pi install git:github.com/keen99/pi-usage-status
```

Local development:

```bash
pi install /absolute/path/to/pi-usage-status
```

This extension replaces status functionality from `@javargasm/pi-usage-bars` and `@narumitw/pi-codex-usage`. Remove those packages to avoid duplicate status entries. Keep `@narumitw/pi-codex-accounts` for account switching.

```bash
pi remove npm:@javargasm/pi-usage-bars
pi remove npm:@narumitw/pi-codex-usage
```

## Commands

```text
/usage
```

`/usage` reloads configuration, refreshes, and shows detailed usage for every available Z.AI and Codex subscription. This includes all accounts managed by `@narumitw/pi-codex-accounts` plus standard Pi Codex auth. Status bar remains limited to active provider/account.

```text
/usage-reset [account]
```

`/usage-reset` redeems one available usage reset: Codex account credits (tested) or GLM reset cards (`/usage-reset glm`, **UNTESTED** — see above). GLM path always shows a confirmation dialog stating the endpoint is unverified before consuming anything.

## Configuration

Optional file: `~/.pi/agent/pi-usage-status.json`

```json
{
  "providerDisplay": "active",
  "codexAccountDisplay": "active",
  "percentageStyle": "used",
  "toolsLabel": "icon",
  "refreshIntervalMs": 60000,
  "requestTimeoutMs": 5000,
  "showProviderLabel": true,
  "showAccountName": true,
  "showPlan": true,
  "showResetTimes": true,
  "showResetCards": true,
  "color": true,
  "suppressCodexAccountsStatus": true
}
```

- `providerDisplay`: `active` or `all`
- `codexAccountDisplay`: `active` or `all`
- `percentageStyle`: `used` or `remaining`
- `toolsLabel`: `icon` (`🔧`) or `text` (`tools`)
- `showResetCards`: `true` or `false` — Z.AI reset-card (`♻N`) display
- `suppressCodexAccountsStatus`: merges account name into this extension's status by hiding separate `codex:teams` badge. Account switching remains untouched.

Defaults show active provider and active Codex account only.

## Refresh behavior

- Startup
- Model selection
- Agent start
- Every 60 seconds during long agent runs
- Agent end
- Manual `/usage`

Failed refreshes retain same-provider/same-account cached data with `◌`. No cross-account cache fallback.

## Security

- Zero runtime dependencies.
- Never writes auth files or refreshes OAuth tokens.
- Reads only Pi auth/config files described above.
- Sends provider credentials only to corresponding provider usage endpoint.
- No telemetry.

## Development

```bash
npm install
npm run check
```

MIT licensed.
