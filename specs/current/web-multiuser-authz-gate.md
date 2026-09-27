# Web multi-user — authorization gate (#3/#4)

Status: local, test-only slice on top of the #2 auth foundation. Tracking: Lei-k/open-design #3, #4 (epic #9). **This is not launch approval.** Nothing here makes the daemon deployable to several real users; see "Known gaps".

Plan context: `specs/current/web-multiuser-ec2-plan.md` (milestone 2). Data paths follow the root `AGENTS.md` "Daemon data directory contract"; this note does not restate them.

## Mode switch

- Default **off**. Off composes the daemon exactly as before: no auth routes, no gate, no auth store, no ownership table. Desktop/local single-user behaviour is unchanged.
- On **only** through the programmatic `startServer({ multiUser })` option, carrying the exact `MULTIUSER_NOT_LAUNCH_READY_ACK` literal (`apps/daemon/src/services/multiuser-mode.ts`). No production entrypoint (cli, sidecar, daemon-startup) passes it; `tests/auth/auth-not-wired.test.ts` is the tripwire.
- There is **no environment switch**. Setting `OD_MULTIUSER_MODE` (or a look-alike name) refuses startup in either mode, so an operator can never believe they enabled isolation while actually running a single-tenant daemon.
- In multi-user mode, startup refuses when:
  - `OD_API_TOKEN` is set: the single-tenant token and its loopback bypass would substitute for per-user sessions;
  - `OD_DISABLE_API_AUTH` is truthy: proxy-delegated auth would substitute for per-user sessions;
  - the bind host is not loopback (this slice is not deployable);
  - `allowedOrigins` are not exact `scheme://host[:port]` origins;
  - the live route inventory contains an unclassified route, an allowed classification has no registered route, or the gate wiring (body policy, ownership store) is incomplete.
- The gate never looks at the peer address, so a loopback peer gets no bypass.

## Request path (multi-user mode)

`installMultiUserFront` (`apps/daemon/src/http/multiuser-gate.ts`) is installed right after the route-registration guard, before every body parser:

1. The gate strips client-asserted identity: every `x-od-*` header, `Authorization`, and `Proxy-Authorization`. Workspace/member/user headers are never authority.
2. It classifies `METHOD path` against the registry. HEAD is treated as GET. Literals match case-insensitively, one trailing slash is tolerated, and params are URI-decoded like Express does.
3. It resolves the session only from the `__Host-od_session` cookie through `AuthService`. The account, role and active flag are re-read on every request, so revocation, deactivation and logout apply to the next request.
4. It refuses cross-origin state-changing requests: an Origin outside the allowed list, or `Sec-Fetch-Site` cross-site/same-site.
5. For owner-scoped routes it checks ownership of the route's project param **before** the handler runs.
6. The auth registrar is mounted next, ahead of the global JSON parser (this resolves the parser-order residual risk noted in `routes/auth.ts`).
7. After the global parser, a body policy restricts project create/patch to descriptive fields.

Denials: no session → 401 for every non-public route (anonymous callers learn nothing about which routes exist). Unclassified → 404. Blocked → 403. Foreign, unowned or missing project → identical `404 PROJECT_NOT_FOUND`. Admin-only without the admin role → 403.

## Route classes

Registry: `apps/daemon/src/http/multiuser-route-classes.ts` (declarative, one reason per group).

| Class | Meaning |
| --- | --- |
| `public-probe` | no session; liveness/readiness/version only |
| `auth` | the auth registrar enforces its own session/admin checks and hardening |
| `admin-only` | session + persisted `admin` role (no entries yet; reserved for #10) |
| `owner-scoped-project` | session + the declared project param must be owned by the actor; **no admin override** |
| `actor-scoped` | session; the handler scopes to the actor (list filter / create bind) |
| `blocked-in-multiuser` | denied to everyone, admins included |
| `middleware` | non-terminal `app.use` entry; never authorizes |

Coverage: the string inventory, routes registered with a RegExp or a path array (recorded separately by `route-registration-guard.ts`), and the static mounts. The SPA catch-all (`GET /*splat`) is blocked and never used to classify a request. `tests/auth/multiuser-gate-http.test.ts` starts the real daemon and fails on any unclassified or stale entry.

### Allowed (the whole list)

- Probes: `GET /api/health`, `/api/ready`, `/api/version`.
- Auth: `/api/auth/*` (bootstrap, login, logout, me, session rotate, password, admin user management).
- Projects: `GET /api/projects` (the actor's own only), `POST /api/projects`, `GET|PATCH|DELETE /api/projects/:id`.
- Conversations: `GET|POST /api/projects/:id/conversations`, `GET /api/projects/:id/conversations/:cid/messages`.

Project create/patch body policy: only `id`, `name`, `metadata`, `pendingPrompt`, `customInstructions`, `skipDiscoveryBrief`, `conversationMode`/`sessionMode` and `automaticStrategyTaskProfile` (create); `name`, `metadata`, `pendingPrompt` and `customInstructions` (patch). `metadata` may carry only descriptive keys, and `kind` must be one of prototype, deck, other, image, video or audio. Refused fields include host paths (`linkedDirs`, `baseDir`, project locations), templates, plugins, skills and design systems.

### Blocked (everything else), by reason

Agent execution (runs, chat, automations, routines, media generation), agent tool-token endpoints, and SSE/event streams. Project file/preview/export/upload planes, including the regex preview/raw/powered routes, plus terminals, browser sessions, deploy, collab and presence. Static mounts (`/artifacts`, `/frames`, plugin previews) and the SPA shell. Host filesystem and desktop integration: folder import, native dialogs, project locations, recent dirs, open-external. Connector/MCP/OAuth/provider credentials and provider proxies. Daemon status/db/shutdown/diagnostics. Global app config and memory. Shared catalogs whose user entries are global: skills, design systems, templates, plugins, marketplaces. Vela workspace features.

## Project ownership (#3)

- Table `multiuser_project_owners` lives in the main daemon SQLite database, next to `projects`. It is created lazily, only when multi-user mode attaches it (`apps/daemon/src/storage/project-ownership.ts`). Placement is justified by atomicity and coherence: the binding is inserted **in the same transaction** as the project row and seed conversation, and `ON DELETE CASCADE` removes it with the project. The auth store stays credentials/sessions only; the owner column holds the opaque account id.
- The binding is immutable: a primary-key conflict blocks re-binding and a trigger aborts every UPDATE. There is no transfer or claim API.
- Rows without an owner (legacy/unbound) are invisible to everyone and never auto-claimed. Re-creating the same id fails.
- Admins are not granted other users' project content.

## Known gaps (not done here)

- **#5 run isolation**: every execution surface is blocked. No per-user filesystem or session isolation exists yet.
- **SSE/static/preview scoping**: project events, run events, file/preview/raw/export routes and static mounts stay blocked until they are provably actor-scoped.
- **#10 admin API/UX**: only the #2 account management routes exist. `admin-only` has no entries, and admins have no project-content view by design.
- **#11 pool + quota**: no scheduling, reservations or ledger are wired. Provider access stays blocked.
- **#6 Web UX**: no login UI and no SPA shell in multi-user mode.
- **#7/#8 deployment gate**: loopback-only bind, no TLS/proxy/rate-limit/backup work. The origin allowlist is exercised only in tests.
- Residual: `POST /api/projects` with a client-chosen id that already exists fails with a conflict. That reveals the id exists, but ids are client-generated UUIDs. `GET /api/projects/:id` still returns the daemon-side `resolvedDir`.
