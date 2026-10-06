# Web multi-user personal subscription linking (#18, epic #9)

Status: test-only slice on top of #2/#13/#15/#16. **No production entrypoint enables a real provider.** This slice proves the account-linking state machine, per-user isolation and a separate personal run lane against a repository mock of `codex app-server`. A sandboxed real-provider switch exists for the direct `startServer` harness only (staging and local acceptance). Startup, gate and loopback rules in `web-multiuser-authz-gate.md` stay in force; `startDaemonRuntime` still refuses every multi-user option. Daemon data paths follow the root `AGENTS.md` **Daemon data directory contract**; this note does not restate them.

## Enablement switch

- Default **off**. Two mutually exclusive fields of the direct `startServer({ multiUser })` option turn it on. Both are resolved by `resolveMultiUserMode`, the first statement of `startServer`, and every refusal happens there, before any side effect.
  - `testPersonalCodexAppServer`: its real path must equal the repository mock `mocks/personal-codex-app-server.ts`. The PATH mock wrapper and any other script are refused.
  - `testPersonalCodexRealBinary: { path, acknowledge }` (user decision 2026-10-06): a real `codex` binary for the personal lane. It needs the exact `PERSONAL_CODEX_REAL_PROVIDER_ACK`, an absolute path to an executable, and `personalSandbox`. The command is always `<codex> app-server -c cli_auth_credentials_store="file"`.
- `personalSandbox: { bwrapPath }` runs every personal app-server child in the per-run sandbox (see "Per-run sandbox"). It is mandatory with the real binary and optional with the mock. Startup refuses when bwrap cannot build the sandbox on the host, for example where unprivileged user namespaces are disabled or restricted by AppArmor.
- There is no environment variable, admin API or UI that enables personal subscriptions or a real provider.
- Off: `GET /api/agent-accounts` answers `personalSubscriptionsEnabled: false`. Login start, verify and personal runs answer `403 MULTIUSER_PERSONAL_DISABLED`. Company-pool runs are unchanged.
- Single-user mode registers none of these routes.
- The account service is built right after the database opens, before any timer or service. If its schema migration or retained-state recovery throws, startup closes the auth store and the database, ends the health session and rethrows (#22). A later start in the same process then succeeds.

### Enablement gates and decisions (user decisions 2026-10-06)

1. **Official applicability: accepted by the owner.** The owner allows hosted, multi-user use of personal ChatGPT plans through the native `codex app-server` device flow. SIWC is not used.
2. **Per-user OS-level isolation: implemented as a per-run sandbox** (option A; not per-user uids or VMs). See "Per-run sandbox".
3. **Secret custody and backup policy: decided.**
   - The deployment encrypts the volume that holds the daemon data root at rest (for example EBS encryption; #7). No application-level encryption: the CLI reads its credential file in plain text.
   - Backups exclude every provider home under the per-actor runtime directories (`codex-home`, `codex-home.previous` and `codex-login-*`). A data root restored from a backup therefore has account rows without credentials. On start, a `connected` account without its credential becomes `requires_reauth`, and only a new authorization restores it.
   - Unlink deletes local state only. The confirmation tells the owner to sign out of all devices in ChatGPT security settings to revoke the authorization at OpenAI.
4. **Two real accounts end-to-end: deferred until after deployment.** It is tested on the staging deployment (`deploy/multiuser/`). The staging launcher `multiuser-serve` enables the real provider when its config names `personalCodex: { binary, bwrap }`. The `multiuser` image target pins the official Codex release and bubblewrap. Its container relaxes seccomp, AppArmor and masked `/proc` paths so the per-run sandbox can be built, and it adds no capabilities and is not privileged.

Also decided on 2026-10-06:

- **Version.** No further version runs. The real run used 0.154.0, whose generated schema contains every method and field below.
- **CLI.** No `od` surface for personal accounts for now; see Follow-ups.
- **Claude Code.** Not started.

### Per-run sandbox

Daemon and agent children share one OS uid, so file modes alone cannot stop a task shell in one user's run from reading another user's CODEX_HOME or the daemon database. With `personalSandbox`, every personal app-server child starts inside bubblewrap (`apps/daemon/src/services/personal-sandbox.ts`). This covers login, the fresh identity read, verification, runs and logout.

- `--unshare-all --share-net --die-with-parent --new-session`. The network stays shared, because the provider is remote.
- Read-only: `/usr` (with the merged-`/usr` top-level symlinks), TLS trust stores, and the `/etc` files needed for name resolution and user lookup. Also read-only: the program paths. For the real CLI that is the release directory holding `bin/` and its bundled helpers; for the mock it is the Node installation and `mocks/`.
- Read-write: only this child's CODEX_HOME, HOME, TMPDIR and working directory. For a run, the working directory is the project directory. `/tmp` is a private tmpfs.
- The rest of the daemon data root, other users' homes, the operator's home and the host's `/tmp` do not exist inside. `PATH` is fixed to the system directories.
- Codex's own command sandbox runs nested inside this one.
- Tests: `personal-codex-sandbox.test.ts` (service) and `multiuser-personal-sandbox-http.test.ts` (daemon run lane). In both, a task in alice's run gets `ENOENT` for bob's credential and for the daemon database, while its own credential stays readable. An unsandboxed control can read bob's credential. Both suites are skipped where bwrap cannot build the sandbox.

### Local real-provider acceptance (2026-10-06, codex 0.154.0)

`apps/daemon/tests/real-provider/personal-codex-real.acceptance.test.ts` drives the account service against a real `codex app-server`. It launches it exactly as `testPersonalCodexRealBinary` resolves it: file credentials, every child sandboxed, and `OD_REAL_CODEX_ACCEPTANCE_BWRAP` defaulting to `/usr/bin/bwrap`. It is skipped unless `OD_REAL_CODEX_ACCEPTANCE_BIN` names a binary.

A first run on a single Pro account, before the sandbox existed, passed all five steps:

1. A pending device login was canceled.
2. A device-code login approved by the owner linked a private isolated home (0700/0600). Its credential was not a copy of the operator's own CODEX_HOME.
3. Verification was refused without consent and succeeded with one minimal turn.
4. A turn and a follow-up resumed the same native thread and recalled the earlier turn.
5. Unlink removed every copy.

A second run on the same account with every child sandboxed also passed all five steps, including the device login, verification, the resumed follow-up thread and unlink.

Findings:

- The real app-server announces `account/login/completed { success: true }` before that process's `account/read` carries the account. The first acceptance attempt therefore failed with `identity_unavailable`. When the live read has no e-mail, the service now reads the identity once more from a fresh app-server on the persisted login home, which also proves the credential landed in that home. The mock reproduces this with the `approve-stale-read` outcome.
- An isolated home has no `config.toml`, so the CLI may choose an OS keyring, which every home of the same OS user shares. The real-provider command therefore always pins `-c cli_auth_credentials_store="file"`.

## Provider protocol (pinned: codex 0.160.0)

The daemon uses exactly these app-server methods, with names and fields taken from the generated 0.160.0 schema: `initialize`/`initialized`, `account/login/start` with `{ type: "chatgptDeviceCode" }` (returns `loginId`, `verificationUrl`, `userCode`), the `account/login/completed` notification, `account/login/cancel`, `account/read`, `account/rateLimits/read`, `account/logout`, and the `thread/start`/`thread/resume`/`turn/start`/`turn/completed` turn path. The OpenAI-internal `chatgptAuthTokens` login type and every token-forwarding path are never used.

## Per-user provider home

- Each platform account gets one CODEX_HOME. It sits in the same per-actor runtime directory the isolated run lane uses, under the resolved daemon data root. Directories are 0700 and files 0600. Modes are re-applied after every link, verification and personal run, because provider children write with their own umask.
- A login runs in a separate login home inside the same actor directory. On a successful, accepted first link that home atomically replaces the actor's CODEX_HOME. A same-identity re-authorization moves only the credential file (`auth.json`) into the existing CODEX_HOME, so the owner's native sessions survive. The previous credential is kept as a private backup inside that CODEX_HOME until the bind commits. Any failure after the first credential change, including permission hardening, restores it. If the restore itself fails, the backup stays in place and the account becomes `requires_reauth`; it is never left usable. A re-authorization that switches to a different identity replaces the whole CODEX_HOME with the login home, as a first link does. The previous home is set aside beside it until the bind commits. Any failure restores that home and the account row; if the restore fails, the set-aside home is kept and the account becomes `requires_reauth`. Every other outcome deletes the login home. Nothing is ever copied between actors, and there is no global CODEX_HOME.
- Every app-server child gets an explicit environment: `CODEX_HOME`, `HOME`, `TMPDIR`/`TMP`/`TEMP` and `OD_DATA_DIR`. Nothing is inherited. Personal runs use a per-run HOME/TMP separate from the CODEX_HOME.

### Retained prior state

- Before a re-authorization first changes any file, it durably records that this owner's prior state is being set aside. The record says whether this is the whole home (switch) or the credential file (same identity), and whether a prior copy existed. The bind transaction deletes the record together with the account update. So while a record exists, the set-aside copy, not the active home, is the account's truth. The account is never usable while a record exists.
- A failed bind puts the copy back and deletes the record. If putting it back also fails, the copy stays private (0700/0600), the record stays, and the account becomes `requires_reauth`.
- Reconciliation runs on restart and before any later re-authorization installs anything. With a record, the retained copy moves back into place, replacing whatever uncommitted replacement stands there, and the record is deleted. Without a record, copies left beside the home belong to a committed replacement and are deleted. A retained copy is never deleted or overwritten before a replacement commits. If it cannot be moved back, nothing new is installed and the account stays `requires_reauth`.
- So a same-identity re-authorization after a failed switch recovers the original native sessions. A switch retry that fails again keeps the only prior home.
- Original credentials and native-session continuity are destroyed only by a proven committed replacement (the commit transaction that deletes the record) or by a successful owner unlink. A missing record is that proof only for copies the record-aware code wrote.
- Upgrade from code before the record existed: those versions could leave `codex-home.previous` or `auth.json.previous` without a record. On the first start that creates the record table, in the same transaction, each such copy of a linked owner is adopted:
  - Sole copy (the active home, or its `auth.json`, is missing): it becomes a `home` / `credential` record and is restored as above. The account stays `requires_reauth` until a re-authorization; a same-identity one keeps the restored native sessions.
  - Copy beside an active one: whether that active copy was committed cannot be told, so the record is `ambiguous`. Every copy stays private (0700/0600), and the account stays unusable and `requires_reauth` (no run admission, dispatch or verification). The owner may re-authorize out of it (user decision 2026-10-03, "re-authorization commit = proof"):
    - The new login replaces the whole home, whatever its identity. Until the commit, the active ambiguous home (with any credential backup inside it) is kept inside the retained `codex-home.previous` copy, so both old copies stay private in the one retained location.
    - The commit updates the same account row as a switch does: credential version bumped, `verifiedAt` and `lastProblem` cleared, status `connected`. It resets the owner's native thread pins in the same transaction, even when the identity is unchanged, and deletes the record. Only after that commit are both old copies deleted. Native-session continuity is not guaranteed for this state, so a pinned conversation's next follow-up starts a fresh thread on the new subscription. It never falls back to the company pool.
    - Anything short of that commit is not deletion authority: pending, expiry, denial, cancel, a provider failure, a file-system or database failure, or a crash. Every byte and mode of both old copies is kept, together with the `ambiguous` record and the fence. An interrupted replacement is undone on the next start or attempt.
    - A successful owner unlink also removes every copy. Another platform user's home, even with the same identity, is never touched.
  - Legacy code could leave these copies, or the active credential beside them, with the provider's own umask (0644). Every start re-applies 0700/0600 to the active home and any retained home copy of every linked or retained owner (#20). Hardening only changes modes: it never moves or deletes a copy, and a record and its fence stay as they were. If a mode cannot be applied the account becomes `requires_reauth`, and the next start tries again.
  - Ordinary (non-ambiguous) same-identity re-authorization still keeps native sessions, and an ordinary switch keeps its rollback semantics.
  - Owners without an account row unlinked earlier. Their leftovers are removed when the owner links again, after that link commits.

## Schema migration

- Databases created before the one-identity-per-provider rule was dropped keep `UNIQUE (provider, identity_hash)`. On start, when the accounts table still has that unique constraint, it is rebuilt in one immediate transaction: same columns, rows and ids, keeping `UNIQUE (owner_account_id, provider)`. The binding and identity triggers are recreated afterwards.
- No other table references the accounts table by foreign key. Login attempts, runs and session pins keep referring to unchanged ids. A failed migration rolls back completely and is retried on the next start; a migrated database is detected and left alone.

## Login attempt state machine

`pending → connected | denied | expired | canceled | failed`. The row is durable and bound to the actor.

- Attempt ids are 32 random bytes in base64url. One pending attempt per user, enforced by a partial unique index. A new start cancels the prior pending attempt and inserts the new one in one immediate transaction, then tears down the old child.
- Expiry: 15 minutes server-side. The durable `expires_at` is checked on read with the injected clock, by a timer set for the time remaining, when a completion arrives, after the identity read-back and again just before credentials are bound. A completion past the deadline ends the attempt as `expired` and binds nothing. A deadline already passed by the read-back has no side effects: no fence, no run cancellation, no credential change. The provider's own expiry/denial arrives as `account/login/completed { success: false }`. Error text maps to `denied` (contains "denied"), `expired` ("expired"/"timeout"), `failed/workspace_not_allowed` ("workspace") or `failed/provider_error`. The real provider's error strings are unverified, so unknown text is `provider_error`.
- Completion is accepted only for the live attempt's own `loginId`, only once, and only while the row is `pending`. Replays, foreign login ids and completions that arrive after cancel, expiry or restart cause no state change.
- On restart every `pending` row becomes `failed/interrupted`, and stray login homes are deleted. Retained prior state is then reconciled (see "Retained prior state").
- Failure codes: `identity_unavailable`, `workspace_not_allowed`, `interrupted`, `provider_error`.

## Account and identity

- Account status: `connected → requires_reauth | disabled`. Unlink deletes the row (`unlinked`). Exactly one Codex account per platform user (`UNIQUE(owner, provider)`).
- Identity read-back: `account/read` in codex 0.160.0 reports `{ type: "chatgpt", email, planType }` and **no account or workspace id**. The identity key is therefore an HMAC-SHA256 of the normalized e-mail. The key is a random per-installation key in the main database. It is stored only as a hash. If the e-mail is missing the attempt fails with `identity_unavailable`.
- One provider identity may be linked by several platform accounts (user decision 2026-10-03). One person may own several platform accounts and may link the same Codex identity under each of them. Isolation is unchanged: each platform account runs its own device-code login into its own CODEX_HOME. Credentials are never copied or shared between platform accounts. Queue limits, unlink, re-authorization and run cancellation stay per platform account. Platform accounts on one subscription share that subscription's provider-side rate limits. The daemon does not aggregate or coordinate them; each account shows the windows the provider reports to it.
- Re-authorization may use the same identity or switch to a different subscription (user decision 2026-10-03: a user may own several subscriptions). It stays one linked account per platform user at a time. Every successful re-authorization bumps the credential version, cancels the owner's queued and active personal runs, and clears `requires_reauth`. While it binds, the account is fenced: no new personal run is admitted or dispatched and verification answers `MULTIUSER_PERSONAL_BUSY`.
  - Same identity: only `auth.json` is replaced. Native sessions are kept, so a pinned conversation's follow-up resumes the same thread.
  - Switch (different identity; defaults chosen by the coordinator, the user may override): the same account row is kept (`id`, owner, provider). Its identity hash, masked identity and plan are replaced. `verifiedAt`, `lastProblem` and the rate limits are reset, and the status becomes `connected`. Native sessions belong to the previous subscription, so they are not carried over. The CODEX_HOME is replaced, and the owner's conversation pins keep their account but lose their native thread id, in the same transaction as the row update. A pinned conversation's next follow-up starts a fresh native thread on the new subscription. It never fails for that reason and never falls back to the company pool. The identity hash can change only together with a credential-version bump and a cleared verification; a database trigger enforces this. Owner and provider stay immutable.
- Display: masked e-mail (`a***@domain`), plan type, link and verify times, and the `account/rateLimits/read` windows (used percent, window, reset) when available. Otherwise the client shows "unknown"; remaining quota and "unlimited" are never derived.
- "Connected" is not "verified". `POST …/verify` requires `{ "consentToUsePlan": true }`. It runs one minimal turn in the owner's home and sets `verifiedAt` only on success.

## Provider failure classes

Classes come from a failed turn's `codexErrorInfo`:

- `unauthorized` → `requires_reauth` (`MULTIUSER_PERSONAL_REAUTH_REQUIRED`, 409).
- `unauthorized` with a workspace message → `disabled` (`MULTIUSER_PERSONAL_WORKSPACE_NOT_ALLOWED`, 403).
- `usageLimitExceeded` → status unchanged with `lastProblem: usage_limit_reached` (`MULTIUSER_PERSONAL_USAGE_LIMIT`, 429).

None of these ever switches the execution source.

Normalized run events keep the safe part of `codexErrorInfo` (#21). A fatal `error` notification and a failed turn both become an `error` event with an optional `codexErrorInfo: { reason, httpStatusCode? }`. `reason` is the protocol's reason name: a bare value such as `usageLimitExceeded`, or the single key of an object variant such as `responseStreamDisconnected`. `httpStatusCode` appears only when the provider forwarded an integer HTTP status (100–599). Free text, additional details and unrecognisable shapes are dropped, and `exec --json` frames, which carry none, keep the historical `{ type, message }` shape. A retrying error (`willRetry: true`) stays a status pill. Only the first error of a turn becomes an event, so account classification keeps reading the failed turn itself.

## API (multi-user mode only)

| Route | Class | Notes |
| --- | --- | --- |
| `GET /api/agent-accounts` | actor-scoped | `{ mode, personalSubscriptionsEnabled, companyPoolAvailable, codex: { account, pendingAttempt }, claude: { available: false } }`; the summary never carries the code. `companyPoolAvailable` is false when no company provider (today: the test mock) is configured; clients treat an absent field as true |
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
- Unlink fences the account synchronously, before its first await. Until the row is deleted, personal runs are refused (`MULTIUSER_PERSONAL_UNAVAILABLE`) and fail at dispatch. Verification, login start and a second unlink answer `MULTIUSER_PERSONAL_BUSY`, and no login can bind. Unlink first cancels the pending login, then the personal runs (it waits for them to exit), then any verification. It then calls `account/logout` as a best-effort local logout. Before the row is deleted, it removes every copy of that user's state: the active home (including a retained credential inside it), a home set aside by a failed switch, and the retained-state record. Another platform user's home is never touched, even when it holds the same provider identity. If that cleanup fails, the account becomes `requires_reauth`, its row stays, the request fails, and unlink can be retried. This is **not** a provider-side revocation. The fence lives in daemon memory. A crash mid-unlink leaves the row linked, and the user can unlink again.

## Personal run lane

- `POST /api/runs` accepts `executionSource: "company_pool" | "personal_subscription"`. When it is omitted or `company_pool`, behaviour and response shape are unchanged. A personal run requires `agentId: "codex"`. A usable account is a linked account with status `connected` and the feature on. Without one the request is rejected with `MULTIUSER_PERSONAL_UNAVAILABLE` and no row is created. It never falls back to the company pool or another account.
- A personal row is bound immutably to the actor, the linked account id and the credential version. Dispatch re-checks all three and the account status, and fails the row with `reason: MULTIUSER_PERSONAL_UNAVAILABLE` on any mismatch.
- Dispatch reads the stored request before it changes any state. A row whose request is not a JSON object with a string `message` fails with `reason: MULTIUSER_RUN_REQUEST_INVALID` and never starts: no start event, worker time or personal turn. The active mark, start time, personal turn and start event commit in one transaction; live SSE starts only after commit. A rejected start transaction fails the still-queued row with `MULTIUSER_PERSONAL_RUN_FAILED`, with no start/end time or turn consumed. A launcher failure after commit, before a child is registered, fails through ordinary finish accounting with the same reason and keeps its turn and start/end times. A registered child owns completion. Either way dispatch moves on to the next row; no global turn counter is rewound.
- The first personal run pins its conversation to that account and native thread. Follow-ups resume the same thread. A company run in a pinned conversation, a personal run in a conversation that already has company runs, or a run from a different (relinked) account gets `MULTIUSER_EXECUTION_SOURCE_MISMATCH`.
- Separate queue path (user decision 2026-10-03):
  - Personal runs consume no company-pool slot and no 30h company worker-time quota, and need no company budget.
  - Per user: at most 1 active and 3 queued personal runs (`MULTIUSER_PERSONAL_QUEUE_LIMIT`), FIFO, independent of that user's company queue.
  - An admin-configurable host-wide ceiling caps concurrent personal workers (default 4; 0 pauses dispatch). Saturated runs wait in their durable queue and dispatch round-robin across users by last personal turn. Changes are audited in the pool audit table.
  - Personal worker time is recorded per row (start/end) for admin visibility only.
- Cancellation, session revocation, deactivation, role change and admin password reset cancel queued and active personal runs, as in #16. Unlink and re-authorization cancel only that user's personal runs. Clean shutdown cancels active rows with `daemon_shutdown`. Crash recovery fails active rows. Queued rows survive a restart.
- Ordinary legacy conversations retain the raw-message behavior. Fixed design conversations created through the multi-user design catalogue compose the legacy slim OpenDesign prompt from bundled-only skill and design-system inputs. The stable prompt is sent on the first native thread turn and again only when its hash changes; global memory, app-config instructions, user-imported resources, plugins, and workspace bindings are excluded.
- Personal turns persist bounded, redacted progress events and a bounded final response. A filesystem baseline records generated or modified project paths in the run output. Command output and environment values are never persisted in progress events.

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

- A CLI (`od`) surface: deferred by the owner (2026-10-06). The CLI has no multi-user session support yet, as in #13/#15/#16. Linking needs a browser for the device code in any case.
- Claude Code personal subscriptions (#18 phase C): not started (owner decision 2026-10-06).
- Integration into the capability-restricted multi-user shell (#6); the first bounded auth/admin/project-metadata slice is in `web-multiuser-web-ux.md`.
