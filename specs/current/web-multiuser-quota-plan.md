# Per-user worker-time quota ledger — scoped implementation plan

Status: proposed local-only slice for Lei-k/open-design #11; base `main` 1b47e60bd46641469fcd8b69c496c4e3a548bc28. Separate from #2 auth foundation and from any provider connector. No remote branch, PR, deployment or credentials.

## Confirmed product contract
Company-funded shared Codex/Claude *capacity*, distinct Web identities and private data; admin-managed `admin`/`user` roles; AWS EC2. Provider account eligibility remains a separate gate. No OAuth profile or subscription credential may be enrolled by this slice.

## Provisional admission policy
- Aggregate 120 **active worker-minutes** per actor over a rolling 7×24-hour window, independent of timezone. Queue wait is free. This is a fairness unit, not provider charges or a hard cost ceiling.
- One active run and at most three queued requests per actor at the scheduler boundary; provider slot limits are configured elsewhere and default to zero until an approved connector exists.
- Deny new starts when consumed active milliseconds reach the actor's configured budget. A run admitted below budget can finish and overshoot; account for the full elapsed time and block subsequent starts. A separate run watchdog, cancellation, and crash recovery limit exposure. No mid-run termination *solely* because the quota rolls over or is exhausted.
- Admin overrides are versioned and audited at integration time; the ledger exposes usage and decisions but **not** role authority. Only a server-verified actor may call it when wired. Disabled users are refused by the upstream auth boundary.

## This slice / explicitly excluded
Implement a durable SQLite usage/admission component in the daemon's established storage pattern with exact-actor identity, project/run id and provider id, idempotent start/end/cancel accounting, transactional one-active-run check, 7-day rolling usage, and read-only balance. Tests prove two actors cannot borrow each other's time, duplicate/replayed finish cannot double charge, simultaneous start honors concurrency even from separate store connections, boundary clocks, restart persistence, invalid values fail closed, and no provider credential is needed. If a queue is included, it must be persistent and fair; otherwise leave queue/scheduling to a later #11 slice. Do **not** attach the ledger to existing routes or spawn paths until #3/#4/#5 and the provider method are resolved.

## Gates
RED→GREEN on the specified invariants, nearest daemon tests, daemon typecheck/build, repository guard, independent trust-boundary review. No checkmark for #11 or #9 from this slice. Production start remains disabled.
