# Sign in and manage accounts in the test web shell

Issue #6 slice 1 adds login, recipient password setup, account administration, audit, and private project metadata to the existing test-only multi-user daemon. It does not activate production. Issues #6 and #10 remain open for their remaining acceptance work.

## Entry and identity

A fresh public `/api/version` response selects the client. Missing capabilities preserve compatibility with older single-user daemons; only `multiUser: true` selects this shell. Malformed mode values fail closed. Network and 5xx failures retry after 250, 750 and 1500 ms before displaying manual Retry; neither app mounts while discovery is unresolved. Only a validated single-user response imports the existing App, analytics and workspace bootstrap. Multi-user mode uses the existing HttpOnly cookie endpoints without browser tokens or a second workspace identity.

Session checks run on focus, visible-tab changes and a 60-second heartbeat. Routine checks preserve the subtree, form drafts and setup links while `/api/auth/me` reports the same id, role and active state. Checks wait for local mutations to settle; a check begun before a mutation cannot publish over it. Identity changes, 401, logout and cross-tab invalidation withdraw the subtree. If withdrawal interrupts a mutation, an account-free “outcome unknown” notice advises checking the original account’s list before retrying. Pending cross-tab mutations stay withdrawn until completion; reloading recovers a tab if its peer closes before sending completion. History navigation withdraws the subtree before page caching and rechecks on return. Requests carry a generation and abort signal; late results, including 401 responses, cannot update a newer generation. The subtree is keyed by generation, account and role. Private state stays in memory; locale and existing appearance preferences remain independent.

## Account workflow

Administrators open **Users** to provision a username and role. The recipient chooses the password through a one-use link. The browser reads its fragment, removes it from location before API requests, and retains the credential only for that setup form. Success requires a separate login. There is no public registration or bootstrap form.

Admins can search and page accounts, issue replacement setup/reset links, change roles, enable or disable accounts, and revoke sessions. Confirmation precedes access changes. The signed-in admin cannot reset, disable or demote their own account in this UI; another administrator must perform those actions. The server retains last-admin protection and primary authorization. Links are dismissible and disappear with their identity subtree. **Account audit** displays bounded lifecycle metadata pages. Admins see only their own project metadata under **My projects**.

## Public code and private resources

The daemon registers explicit GET/HEAD shell routes: `/`, `/login`, `/setup`, `/projects`, `/admin/users`, and `/admin/audit`. It serves the app icon, the three existing font files, and restricted Next build assets under `/_next/static/chunks/` and `/_next/static/media/`. Source maps, arbitrary files, encoded or noncanonical paths, and symlinks are refused. A symlinked static root also fails closed. Public shell documents contain no account data and carry `X-Frame-Options: DENY`. The generic static tree remains inert and the generic SPA fallback remains blocked in multi-user mode. Every registration remains in the startup inventory audit.

The exact test-only acknowledgement, loopback restriction, production `startDaemonRuntime` refusal, and real-provider restrictions are unchanged. Daemon data paths follow the root [Daemon data directory contract](../../AGENTS.md#daemon-data-directory-contract).

## Validation and remaining slices

Maintained web tests cover capability discovery, setup consumption, account switching with deferred responses, stale 401 responses, cross-tab logout, and focus revalidation. Real daemon HTTP tests cover the static allowlist and negative controls. Browser acceptance uses the production static export and real isolated direct `startServer` backend through a task-owned HTTPS proxy, with native Secure cookies and synthetic accounts. The current committed Playwright fixture uses the production lifecycle, which intentionally refuses this mode; its launcher is unchanged. Exploratory browser scripts and evidence live outside the source tree.

Conversation and run UX, owner SSE, execution-source selection, personal Agent accounts integration, admin pool/quota/usage, and CLI parity belong to later slices. File access and generation are not offered by this shell. Production deployment, OS isolation, secrets and real-provider acceptance remain separate gates under #7/#8/#14. This slice grants no production readiness or full UX/CLI parity claim.
