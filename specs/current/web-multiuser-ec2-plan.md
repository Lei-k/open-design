# Web multi-user on EC2 — phased delivery plan

Status: planning + first local implementation slice. Baseline: `main` at `1b47e60bd46641469fcd8b69c496c4e3a548bc28`. Tracking: Lei-k/open-design #9; initial code slice #2. No production deployment or provider-credential enrollment is authorized by this plan.

## Confirmed product decisions

- One AWS EC2 deployment; several independent Web users sign in with local username/password. No public registration: admin provisions users. One-time first-admin bootstrap. Initial roles `admin` and `user`; private projects/conversations/runs/files per user. Team data sharing is not in MVP. No legacy data to import.
- Company organization API keys are the chosen credential supply for shared Codex and Claude capacity (#14). Key custody, isolation and provider enrollment remain separate gates. This test-only pool slice grants real providers zero runnable slots and accepts only the repository mock agent.
- Users share *capacity*, never login sessions, provider credentials, CLI sessions, personal workspaces, or execution files. Only admins manage accounts/roles/capacity.
- Users may additionally link their OWN Codex subscription as a separate execution source (#18). It never joins the shared pool, and the real provider stays disabled behind recorded enablement gates; see `web-multiuser-personal-subscription.md`.

## Provisional per-user quota (#11)

- Start with a company-internal, admin-adjustable default of **30 hours (1,800 active worker-minutes) per user per seven-day window**, aggregated across Codex and Claude. This is a scheduling/fairness unit, *not* a provider billing limit or subscription-allowance measurement. Queue wait is free; actual active elapsed time is charged (including cancelled runs until cancellation completes). Persist a ledger with run id, actor, provider, start/end, and charged duration. Present both quota and provider-reported actual usage when available, never equate them.
- One active run and up to three queued runs per user initially; per-provider slot capacity is configurable and defaults to zero until an approved provider setup is configured. Fair round-robin among eligible users; preserve exact actor/project/provider/session binding across follow-up turns. Reject new requests over quota, do not cut off an already active run solely on weekly rollover/exhaustion. Worker watchdog and cancellation are independent safety bounds. An admin can assign a higher/lower quota and disable an account; neither action discloses private prompts. Metering, atomic reservations, retry/idempotency and rollover tests precede enabling workers.
- Revisit the defaults with observed contention and subscription/organizational capacity before launch; never imply worker-minutes correspond to dollars or provider limits.

## Ordered milestones / exit criteria

1. **#2 auth foundation (this local branch):** server-side account/session persistence, password hashing, bootstrap and admin-created accounts, login/logout/me, revocation. Multi-user mode is opt-in; existing local/desktop mode stays unchanged. No multi-user deployment yet. Focused RED→GREEN tests for unauthorized access, password mistakes, expired/revoked sessions, admin-only actions, and restart persistence.
2. **#3/#4 ownership + authorization:** bind every API/list/direct lookup/event/download/preview and resource path to authenticated actor; default private, deny header spoofing and cross-account requests. Empty deployment means no automatic legacy claiming but still test fail-closed if old rows appear. Do not expose the daemon to multiple real users until this and #5 pass. Local test-only gate slice: `specs/current/web-multiuser-authz-gate.md`.
3. **#10 admin UX/API, #11 pool + quota, #5 run isolation, #6 Web UX:** backend role matrix; credential-secret boundary; durable queue; exact-session and filesystem isolation; UI. Provider integration stays disabled until the provider-approved method is recorded and demonstrated.
4. **#7/#8 EC2 deployment gate:** TLS reverse proxy, bind daemon privately, exact origins, cookie/CSRF/rate limits, secrets, encrypted backup/restore and audit, 2-account+admin browser tests, concurrent run/failure/revocation tests, per-provider credentials and quota proof. No production rollout on partial green.

## Source constraints

- Root `AGENTS.md` is authoritative for `OD_DATA_DIR` and daemon-owned paths; new routes belong in `apps/daemon/src/routes/`, domain services in `src/services/` or `src/storage/`, tests in `apps/daemon/tests/`.
- Base stack is Express + SQLite (`apps/daemon/src/server.ts`, `src/db.ts`) with global `OD_API_TOKEN` and a loopback bypass (`src/api-token-auth.ts`, `server.ts`); those are not per-user auth. Existing Vela workspace members are not the Web login principal.
- This fork's main SHA is a frozen basis for the local branch. Keep one writer in one worktree. Do not push or open a PR without separate authorization for this non-Argus repository. Report local gates and blockers honestly.
