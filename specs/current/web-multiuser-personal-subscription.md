# Web multi-user personal subscription linking (#18, epic #9)

Status: local, test-only slice on top of #2/#13/#15/#16. **The real provider stays disabled.** This slice proves the account-linking state machine, per-user isolation and a separate personal run lane against a repository mock of `codex app-server`. Startup, gate and loopback rules in `web-multiuser-authz-gate.md` stay in force. Daemon data paths follow the root `AGENTS.md` **Daemon data directory contract**; this note does not restate them.

## Enablement switch

- Default **off**. The switch is the `testPersonalCodexAppServer` field of the direct `startServer({ multiUser })` test option. `resolveMultiUserMode` refuses startup unless its real path equals the repository mock `mocks/personal-codex-app-server.ts`. The real `codex` binary, the PATH mock wrapper and any other script are refused before any side effect.
- There is no environment variable, admin API or UI that enables personal subscriptions or a real provider.
- Off: `GET /api/agent-accounts` answers `personalSubscriptionsEnabled: false`. Login start, verify and personal runs answer `403 MULTIUSER_PERSONAL_DISABLED`. Company-pool runs are unchanged.
- Single-user mode registers none of these routes.

### Enablement gates (not satisfied)

Real enablement needs all of the following. None is met by this slice.

1. **Official applicability.** Record whether hosted, multi-user use of personal ChatGPT plans is allowed through the native `codex app-server` device flow, or only through Sign in with ChatGPT (SIWC) and its interest-form path for hosted apps. Record the conditions and approvals. Until then the provider stays disabled.
2. **Per-user OS-level isolation.** Daemon and agent children run under the same OS uid. Filesystem modes (0700/0600) cannot stop a task shell in one user's run from reading another user's CODEX_HOME. Real enablement needs a per-user uid or sandbox boundary (#5/#7).
3. **Secret custody and backup policy** for provider auth stores: encryption at rest, backup exclusion/retention, and restore/revocation handling (#7).
4. **Two real accounts end-to-end** on staging, plus a browser regression (#8).

## Provider protocol (pinned: codex 0.160.0)

The daemon uses exactly these app-server methods, with names and fields taken from the generated 0.160.0 schema: `initialize`/`initialized`, `account/login/start` with `{ type: "chatgptDeviceCode" }` (returns `loginId`, `verificationUrl`, `userCode`), the `account/login/completed` notification, `account/login/cancel`, `account/read`, `account/rateLimits/read`, `account/logout`, and the `thread/start`/`thread/resume`/`turn/start`/`turn/completed` turn path. The OpenAI-internal `chatgptAuthTokens` login type and every token-forwarding path are never used.

## Per-user provider home

- Each platform account gets one CODEX_HOME. It sits in the same per-actor runtime directory the isolated run lane uses, under the resolved daemon data root. Directories are 0700 and files 0600. Modes are re-applied after every link, verification and personal run, because provider children write with their own umask.
- A login runs in a separate login home inside the same actor directory. On a successful, accepted first link that home atomically replaces the actor's CODEX_HOME. A same-identity re-authorization moves only the credential file (`auth.json`) into the existing CODEX_HOME, so the owner's native sessions survive. The previous credential is kept as a private backup inside that CODEX_HOME until the bind commits. Any failure after the first credential change, including permission hardening, restores it. If the restore itself fails, the backup stays in place and the account becomes `requires_reauth`; it is never left usable. Every other outcome deletes the login home. Nothing is ever copied between actors, and there is no global CODEX_HOME.
- Every app-server child gets an explicit environment: `CODEX_HOME`, `HOME`, `TMPDIR`/`TMP`/`TEMP` and `OD_DATA_DIR`. Nothing is inherited. Personal runs use a per-run HOME/TMP separate from the CODEX_HOME.

## Login attempt state machine

`pending → connected | denied | expired | canceled | failed`. The row is durable and bound to the actor.

- Attempt ids are 32 random bytes in base64url. One pending attempt per user, enforced by a partial unique index. A new start cancels the prior pending attempt and inserts the new one in one immediate transaction, then tears down the old child.
- Expiry: 15 minutes server-side. The durable `expires_at` is checked on read with the injected clock, by a timer set for the time remaining, when a completion arrives, after the identity read-back and again just before credentials are bound. A completion past the deadline ends the attempt as `expired` and binds nothing. A deadline already passed by the read-back has no side effects: no fence, no run cancellation, no credential change. The provider's own expiry/denial arrives as `account/login/completed { success: false }`. Error text maps to `denied` (contains "denied"), `expired` ("expired"/"timeout"), `failed/workspace_not_allowed` ("workspace") or `failed/provider_error`. The real provider's error strings are unverified, so unknown text is `provider_error`.
- Completion is accepted only for the live attempt's own `loginId`, only once, and only while the row is `pending`. Replays, foreign login ids and completions that arrive after cancel, expiry or restart cause no state change.
- On restart every `pending` row becomes `failed/interrupted`, and stray login homes are deleted.
- Failure codes: `account_mismatch`, `identity_unavailable`, `workspace_not_allowed`, `interrupted`, `provider_error`.

## Account and identity

- Account status: `connected → requires_reauth | disabled`. Unlink deletes the row (`unlinked`). Exactly one Codex account per platform user (`UNIQUE(owner, provider)`).
- Identity read-back: `account/read` in codex 0.160.0 reports `{ type: "chatgpt", email, planType }` and **no account or workspace id**. The identity key is therefore an HMAC-SHA256 of the normalized e-mail. The key is a random per-installation key in the main database. It is stored only as a hash. If the e-mail is missing the attempt fails with `identity_unavailable`.
- One provider identity may be linked by several platform accounts (user decision 2026-10-03). One person may own several platform accounts and may link the same Codex identity under each of them. Isolation is unchanged: each platform account runs its own device-code login into its own CODEX_HOME. Credentials are never copied or shared between platform accounts. Queue limits, unlink, re-authorization and run cancellation stay per platform account. Platform accounts on one subscription share that subscription's provider-side rate limits. The daemon does not aggregate or coordinate them; each account shows the windows the provider reports to it.
- Re-authorization must be the same identity, otherwise `failed/account_mismatch`; unlink first to switch accounts. A successful re-authorization bumps the credential version, cancels the owner's queued and active personal runs, and clears `requires_reauth`. While it binds, the account is fenced: no new personal run is admitted or dispatched and verification answers `MULTIUSER_PERSONAL_BUSY`. Native sessions are kept, so a pinned conversation's follow-up resumes the same thread.
- Display: masked e-mail (`a***@domain`), plan type, link and verify times, and the `account/rateLimits/read` windows (used percent, window, reset) when available. Otherwise the client shows "unknown"; remaining quota and "unlimited" are never derived.
- "Connected" is not "verified". `POST …/verify` requires `{ "consentToUsePlan": true }`. It runs one minimal turn in the owner's home and sets `verifiedAt` only on success.

## Provider failure classes

Classes come from a failed turn's `codexErrorInfo`:

- `unauthorized` → `requires_reauth` (`MULTIUSER_PERSONAL_REAUTH_REQUIRED`, 409).
- `unauthorized` with a workspace message → `disabled` (`MULTIUSER_PERSONAL_WORKSPACE_NOT_ALLOWED`, 403).
- `usageLimitExceeded` → status unchanged with `lastProblem: usage_limit_reached` (`MULTIUSER_PERSONAL_USAGE_LIMIT`, 429).

None of these ever switches the execution source.

## API (multi-user mode only)

| Route | Class | Notes |
| --- | --- | --- |
| `GET /api/agent-accounts` | actor-scoped | `{ mode, personalSubscriptionsEnabled, codex: { account, pendingAttempt }, claude: { available: false } }`; the summary never carries the code |
| `POST /api/agent-accounts/codex/logins` | actor-scoped | 202 `{ attempt }` with `verificationUrl` + `userCode` |
| `GET /api/agent-accounts/codex/logins/:attemptId` | owner-scoped-agent-account | code/URL only while pending |
| `POST /api/agent-accounts/codex/logins/:attemptId/cancel` | owner-scoped-agent-account | idempotent |
| `POST /api/agent-accounts/codex/accounts/:accountId/verify` | owner-scoped-agent-account | consent required |
| `DELETE /api/agent-accounts/codex/accounts/:accountId` | owner-scoped-agent-account | unlink |
| `GET /api/admin/agent-accounts` | admin-only | linked, status, timestamps, personal worker ms, ceiling, counts |
| `PUT /api/admin/agent-accounts/personal-capacity` | admin-only | `{ capacity: 0..16 }` |

The gate checks the attempt or account owner before the handler. Foreign, missing and forged ids all get the same `404 NOT_FOUND`, with no admin override. Admins cannot link, verify, use or read another user's account, and the admin view has no e-mail, mask, plan or secret.

Error codes: `MULTIUSER_PERSONAL_DISABLED` 403, `MULTIUSER_PERSONAL_UNAVAILABLE` 409, `MULTIUSER_PERSONAL_CONSENT_REQUIRED` 400, `MULTIUSER_PERSONAL_QUEUE_LIMIT` 409, `MULTIUSER_PERSONAL_BUSY` 409 (verification already running, or the account is being unlinked or re-authorized), `MULTIUSER_PERSONAL_REAUTH_REQUIRED` 409, `MULTIUSER_PERSONAL_USAGE_LIMIT` 429, `MULTIUSER_PERSONAL_WORKSPACE_NOT_ALLOWED` 403, `MULTIUSER_EXECUTION_SOURCE_MISMATCH` 409. A generic verification failure is `AGENT_EXECUTION_FAILED` 502.

## Secrets

- `userCode` and `verificationUrl` live only in daemon memory for the live pending attempt. They are returned only to the owner's start or attempt read while pending. They are never persisted, logged, audited, sent over SSE or run events, or returned after the attempt is terminal.
- No API returns tokens, auth file contents or another user's account data. App-server stderr is discarded and frames are never logged.
- Unlink fences the account synchronously, before its first await. Until the row is deleted, personal runs are refused (`MULTIUSER_PERSONAL_UNAVAILABLE`) and fail at dispatch. Verification, login start and a second unlink answer `MULTIUSER_PERSONAL_BUSY`, and no login can bind. Unlink first cancels the pending login, then the personal runs (it waits for them to exit), then any verification. It then calls `account/logout` as a best-effort local logout and deletes that user's home. This is **not** a provider-side revocation. The fence lives in daemon memory. A crash mid-unlink leaves the row linked, and the user can unlink again.

## Personal run lane

- `POST /api/runs` accepts `executionSource: "company_pool" | "personal_subscription"`. When it is omitted or `company_pool`, behaviour and response shape are unchanged. A personal run requires `agentId: "codex"`. A usable account is a linked account with status `connected` and the feature on. Without one the request is rejected with `MULTIUSER_PERSONAL_UNAVAILABLE` and no row is created. It never falls back to the company pool or another account.
- A personal row is bound immutably to the actor, the linked account id and the credential version. Dispatch re-checks all three and the account status, and fails the row with `reason: MULTIUSER_PERSONAL_UNAVAILABLE` on any mismatch.
- The first personal run pins its conversation to that account and native thread. Follow-ups resume the same thread. A company run in a pinned conversation, a personal run in a conversation that already has company runs, or a run from a different (relinked) account gets `MULTIUSER_EXECUTION_SOURCE_MISMATCH`.
- Separate queue path (user decision 2026-10-03):
  - Personal runs consume no company-pool slot and no 30h company worker-time quota, and need no company budget.
  - Per user: at most 1 active and 3 queued personal runs (`MULTIUSER_PERSONAL_QUEUE_LIMIT`), FIFO, independent of that user's company queue.
  - An admin-configurable host-wide ceiling caps concurrent personal workers (default 4; 0 pauses dispatch). Saturated runs wait in their durable queue and dispatch round-robin across users by last personal turn. Changes are audited in the pool audit table.
  - Personal worker time is recorded per row (start/end) for admin visibility only.
- Cancellation, session revocation, deactivation, role change and admin password reset cancel queued and active personal runs, as in #16. Unlink and re-authorization cancel only that user's personal runs. Clean shutdown cancels active rows with `daemon_shutdown`. Crash recovery fails active rows. Queued rows survive a restart.
- In this slice the prompt is the raw message (no system prompt), and runs are not wired to the web composer.

## Audit

`multiuser_agent_account_audit` is append-only (UPDATE and DELETE are aborted by triggers) and holds non-sensitive metadata only:

- Login and account actions: `link_start`, `link_cancel` (including `replaced`), `link_complete`, `link_deny`, `link_expire`, `link_fail`, `link_interrupted`, `verify`, `status_change`, `unlink`.
- Run routing decisions: `run_routed`, `run_rejected`.

Rows record actor and target account ids, a code and a reference id (attempt, account or run id), never codes, URLs, e-mails or tokens.

## Web UI

Settings → "Agent accounts" appears only on a daemon whose public `GET /api/version` reports `capabilities.multiUser: true` (absent on single-user daemons, whose payload is unchanged) **and** whose `GET /api/agent-accounts` answers a valid summary for the signed-in user. A single-user daemon is never probed. A refused or invalid probe (401, errors, unexpected shape) keeps the section hidden.

- The Codex card covers not-linked, pending, connected, requires-reauth, disabled, usage-limit and feature-off states. Pending shows the official link, the copyable code, a countdown and a waiting indicator. Connected offers verify (behind a consent checkbox), re-authorize and unlink (behind a confirm step). It never asks for a password or token.
- The Claude Code card says "Coming later" and has no action.
- A badge marks the source as personal, distinct from the company pool.
- en, zh-TW and zh-CN are translated. Other locales carry the English text until translated.

Follow-ups:

- A run-composer source picker.
- A CLI (`od`) surface. The CLI has no multi-user session support yet, as in #13/#15/#16.
- A served multi-user SPA shell (#6).
