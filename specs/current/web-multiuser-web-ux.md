# Accounts, conversations and runs in the test web shell

Issue #6 is phased and remains open. Slice 1 adds login, recipient password setup, account administration, audit, and private project metadata. Slice 2 adds private conversations, test runs and personal Agent accounts. Neither slice activates production. Issues #6 and #10 retain their remaining acceptance work.

## Entry and identity

A fresh public `/api/version` response selects the client. Missing capabilities preserve compatibility with older single-user daemons; only `multiUser: true` selects this shell. Malformed mode values fail closed. Network and 5xx failures retry after 250, 750 and 1500 ms before displaying manual Retry; neither app mounts while discovery is unresolved. Only a validated single-user response imports the existing App, analytics and workspace bootstrap. Multi-user mode uses the existing HttpOnly cookie endpoints without browser tokens or a second workspace identity.

Session checks run on focus, visible-tab changes and a 60-second heartbeat. Routine checks preserve the subtree, form drafts and setup links while `/api/auth/me` reports the same id, role and active state. Checks wait for local mutations to settle; a check begun before a mutation cannot publish over it. Identity changes, 401, logout and cross-tab invalidation withdraw the subtree. If withdrawal interrupts a mutation, an account-free “outcome unknown” notice advises checking the original account’s list before retrying. Pending cross-tab mutations stay withdrawn until completion; reloading recovers a tab if its peer closes before sending completion. History navigation withdraws the subtree before page caching and rechecks on return. Requests carry a generation and abort signal; late results, including 401 responses, cannot update a newer generation. The subtree is keyed by generation, account and role. Private state stays in memory; locale and existing appearance preferences remain independent.

## Account workflow

Administrators open **Users** to provision a username and role. The recipient chooses the password through a one-use link. The browser reads its fragment, removes it from location before API requests, and retains the credential only for that setup form. Success requires a separate login. There is no public registration or bootstrap form.

Admins can search and page accounts, issue replacement setup/reset links, change roles, enable or disable accounts, and revoke sessions. Confirmation precedes access changes. The signed-in admin cannot reset, disable or demote their own account in this UI; another administrator must perform those actions. The server retains last-admin protection and primary authorization. Links are dismissible and disappear with their identity subtree. **Account audit** displays bounded lifecycle metadata pages. Admins see only their own project metadata under **My projects**.

## Conversations and runs (slice 2)

Projects link to an owner-only conversation list and named conversation creation. Conversation pages reload through the public shell and read private project, conversation and run data through the cookie gate. Foreign and missing resources share the same not-found presentation. Run history includes the owner-only persisted prompt, status and text output; legacy runs without a persisted prompt omit it.

The first run requires an explicit source choice: **Company pool (test mock)** or **My Codex subscription**. Personal is disabled with a reason unless the summary reports the feature enabled and a connected account. The earliest persisted run determines the pinned source; changing source requires a new conversation. Admission and execution errors are localized, and personal failures never retry on company capacity. The composer bounds text and encoded message size.

Active runs show queue position, running state, terminal result and cancellation. Persisted SSE sequence ids deduplicate replay and live events across reconnects. Owner reads reconcile queue positions and interrupted streams. Every request and reader belongs to both the session generation and component mount, including logout, identity changes, 401, cross-tab withdrawal and pagehide. Private histories and device codes remain in memory.

**Agent accounts** reuses the existing Settings section for linking, pending device authorization, cancellation, consented verification, reauthorization and unlinking. Codes display only during unexpired pending attempts. Claude remains “coming later.” The company and personal execution lanes still run only repository mocks through the existing direct-server test options.

## Public code and private resources

The daemon registers explicit GET/HEAD shell routes: `/`, `/login`, `/setup`, `/projects`, `/projects/:projectId`, `/projects/:projectId/conversations/:conversationId`, `/account/agents`, `/admin/users`, and `/admin/audit`. Each id matches one safe segment; there is no public catch-all. It serves the app icon, the three existing font files, and restricted Next build assets under `/_next/static/chunks/` and `/_next/static/media/`. Source maps, arbitrary files, encoded or noncanonical paths, and symlinks are refused. A symlinked static root also fails closed. Public shell documents contain no account data and carry `X-Frame-Options: DENY`. The generic static tree remains inert and the generic SPA fallback remains blocked in multi-user mode. Every registration remains in the startup inventory audit.

The exact test-only acknowledgement, loopback restriction, production `startDaemonRuntime` refusal, and real-provider restrictions are unchanged. Daemon data paths follow the root [Daemon data directory contract](../../AGENTS.md#daemon-data-directory-contract).

## Validation and remaining slices

Maintained web tests cover capability discovery, setup consumption, account switching with deferred responses, stale 401 responses, cross-tab logout, and focus revalidation. Real daemon HTTP tests cover the static allowlist and negative controls. Browser acceptance uses the production static export and real isolated direct `startServer` backend through a task-owned HTTPS proxy, with native Secure cookies and synthetic accounts. The current committed Playwright fixture uses the production lifecycle, which intentionally refuses this mode; its launcher is unchanged. Exploratory browser scripts and evidence live outside the source tree.

Slice 3 retains admin pool/quota/usage views and CLI parity. A separate My runs index is deferred; this slice exposes runs within each conversation. File access and generation are not offered by this shell. Production deployment, OS isolation, secrets and real-provider acceptance remain separate gates under #7/#8/#14. This slice grants no production readiness or full UX/CLI parity claim.
