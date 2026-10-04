# Web multi-user admin users (#10)

Status: local, test-only backend slice on top of #2/#3/#4. Tracking: Lei-k/open-design #10 (epic #9). It makes the account lifecycle backend ready for the #6 Web integration. The backend originally shipped without UI or CLI. The bounded web shell now consumes it; see `web-multiuser-web-ux.md`. #10 remains open for full acceptance and CLI parity. The mode switch, gate and loopback rules in `web-multiuser-authz-gate.md` stay in force. Daemon data paths follow the root `AGENTS.md` "Daemon data directory contract"; this note does not restate them.

## Account lifecycle

Admins provision accounts; the recipient chooses the first password. Each account has a `passwordState`:

| State | Meaning | Can sign in |
| --- | --- | --- |
| `set` | a usable password exists | yes, while active |
| `setup_required` | provisioned, waiting for the recipient's first password | no |
| `reset_required` | an admin issued a reset; the old password is retired | no |

Transitions:

- **Provision** (`POST /api/auth/users` without `password`): a new account in `setup_required` plus a setup credential.
- **Issue** (`POST /api/auth/users/:id/password` without `password`): on `setup_required` or `reset_required`, a fresh credential replaces the outstanding one. On `set`, the same transaction retires the password, deletes every session of the account and moves it to `reset_required`; the route then cancels the owner's queued and active company and personal runs through the existing revocation callback. Refused for a deactivated account.
- **Complete** (`POST /api/auth/setup`): the credential's owner sets a password under the normal password policy, and the account moves to `set`. This does not sign in; the owner logs in normally.
- **Deactivate** withdraws any outstanding credential.

Bootstrap stays the one-shot, secret-gated creation of the first admin (state `set`). There is no public registration.

## Setup and reset credentials

- 32 random bytes, base64url. The raw value appears once, in the issuing admin's response. The store keeps only its SHA-256 digest, at most one per account. Lists, audit rows, errors and logs never carry it.
- Lifetime: 24 hours by default (`setupCredentialTtlMs` on `AuthService`). Delivery to the recipient is out of band; there is no e-mail service. A recipient link UI belongs to #6.
- Single use: the committing transaction re-reads the credential by digest, re-checks expiry against the clock after the password KDF, re-checks that the account is active and still waiting, then deletes the credential and sets the password together. A replay, a second concurrent redemption, a reissue or a deactivation during the KDF all lose.
- Unknown, malformed, used, superseded and expired credentials share one answer: `401 UNAUTHORIZED`, "invalid or expired setup credential". A password-policy failure answers `400` and consumes nothing; so does any failed commit.

## Privilege guard

Every admin action re-reads the actor's session, account, role and active flag inside its commit transaction, so an issuer demoted, deactivated or revoked during a KDF commits nothing. At least one usable admin (active, `admin`, state `set`) always survives: demoting, deactivating or resetting the last one answers `409 CONFLICT`. A pending admin does not count, so provisioning one cannot open a last-admin escape.

## Search and audit

- `GET /api/auth/users?q=&limit=&offset=` (admin): accounts in creation order with `{ accounts, page: { total, limit, offset } }`. `q` is a literal username fragment (1-32 characters of the username alphabet, case-folded), `limit` 1-100 (default 50), `offset` 0-10000. Unknown, repeated or malformed parameters answer `400`. The projection is metadata only: id, username, role, active, `passwordState`, timestamps.
- `GET /api/auth/audit?limit=&before=` (admin): newest first, `{ events, nextBefore }`, `limit` 1-100 (default 50).
- The `auth_audit` table in the auth store is append-only (triggers abort UPDATE and DELETE). Each successful mutation writes its row in the same transaction: `bootstrap`, `account_create`, `account_update`, `sessions_revoke`, `credential_issue`, `password_setup`, `password_reset_legacy`. Rows hold actor and target account ids, time, `outcome: "success"` and minimal metadata (role, flags, counts, purpose, expiry). Denials are not audited here; they reach the existing fixed-shape API failure journal, which records no request body. No retention deletion exists; retention policy belongs to #7.

DTOs: `packages/contracts/src/api/auth-accounts.ts`.

## Schema migration

The auth store moves from schema v1 to v2 in one immediate transaction: `auth_accounts.password_state` (existing rows default to `set`), `auth_setup_credentials` and `auth_audit`. Accounts, password hashes, sessions and the bootstrap marker are untouched. A failed upgrade rolls back completely and retries on the next start; a newer schema refuses to open.

## Legacy test-only paths

Two direct-password operations remain reachable in the test-only multi-user mode, for fixtures only. They are not the onboarding flow:

- `POST /api/auth/users` with `password`: the admin chooses the new account's password.
- `POST /api/auth/users/:id/password` with `password`: the admin sets the password directly; it withdraws any outstanding credential and revokes sessions.

Production activation obligation (#7/#8): remove these two body shapes or gate them out before any real deployment, and confirm the 24-hour lifetime and the audit retention as policy.

## Not done here

- #6: the bounded login/setup/admin shell is in `web-multiuser-web-ux.md`; remaining phased browser acceptance and CLI parity at user-facing activation stay open.
- #7/#8: deployment gate, rate limits, secrets, backup and audit retention, real-account staging.
