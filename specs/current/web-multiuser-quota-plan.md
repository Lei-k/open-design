# Per-user worker-time quota ledger — original scoped plan

Status: historical plan for the first, unwired ledger slice. The ledger is now wired only to the test-mock multi-user pool; `web-multiuser-pool.md` is the current behavior specification. No provider connector, deployment or credentials are included.

## Confirmed product contract
Company-funded shared Codex/Claude *capacity*, distinct Web identities and private data; admin-managed `admin`/`user` roles; AWS EC2. Provider account eligibility remains a separate gate. No OAuth profile or subscription credential may be enrolled by this slice.

## Provisional admission policy
- The company-internal, admin-adjustable default is **30 hours (1,800 active worker-minutes)** per actor over a rolling 7×24-hour window, independent of timezone. Queue wait is free. This is a fairness unit, not a provider billing limit or a hard cost ceiling.
- One active run and at most three queued requests per actor at the scheduler boundary; provider slot limits are configured elsewhere and default to zero until an approved connector exists.
- Deny new starts when consumed active milliseconds reach the actor's configured budget. A run admitted below budget can finish and overshoot; account for the full elapsed time and block subsequent starts. A separate run watchdog, cancellation, and crash recovery limit exposure. No mid-run termination *solely* because the quota rolls over or is exhausted.
- Admin overrides are versioned and audited at integration time; the ledger exposes usage and decisions but **not** role authority. Only a server-verified actor may call it when wired. Disabled users are refused by the upstream auth boundary.

## Original ledger slice / exclusions at that time
The original work implemented a durable SQLite usage/admission component with exact-actor identity, project/run id and provider id, idempotent start/end/cancel accounting, transactional one-active-run check, 7-day rolling usage, and read-only balance. Its tests covered actor separation, duplicate finish, simultaneous starts across connections, boundary clocks, restart persistence and invalid values. It deliberately left queue and route wiring for the later test-only pool slice documented in `web-multiuser-pool.md`.

## Original gates
RED→GREEN on the specified invariants, nearest daemon tests, daemon typecheck/build, repository guard, independent trust-boundary review. No checkmark for #11 or #9 from this slice. Production start remains disabled.
