# Web multi-user run isolation (#5, epic #9)

Status: local test-only proof. Multi-user startup and loopback refusal rules in `web-multiuser-authz-gate.md` remain in force. Daemon data paths follow the root `AGENTS.md` **Daemon data directory contract**.

## Allowed execution surface

`POST /api/runs` is the chosen send path because the current Web runtime creates runs through it. `POST /api/chat` remains blocked. The gate also permits `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/events`, and `POST /api/runs/:id/cancel`. The isolated registrar is mounted before the single-user run registrar; all other run and execution routes remain blocked. Startup refuses if the isolated registrar was not attached.

For company-pool runs the only accepted agent id is `test-mock`; personal-subscription runs (#18) accept only `codex` and run through the repository mock app-server in the owner's own CODEX_HOME (`web-multiuser-personal-subscription.md`). Its TypeScript script in `mocks/` is supplied explicitly through the direct test-only `startServer` option and checked against the repository mock file. It is never resolved from host `PATH`. Model, provider, BYOK, tool, MCP, connector, browser, PTY, token and resume request fields are refused with `MULTIUSER_AGENT_FORBIDDEN`. The normal provider launcher is never called. Real Codex/Claude slots depend on #11 and a separately approved provider credential supply; this proof grants neither.

## Durable ownership and execution envelope

The multi-user-only `multiuser_runs` table is created in the main daemon SQLite database. One insert binds a new run id to the authenticated account, an owned project and a conversation belonging to that project. A trigger prevents changing those fields. Missing, unowned and foreign run ids all return the same `404 NOT_FOUND` on detail, events and cancel; admin has no content override. The list filters by account and verifies project ownership. Events are persisted by run id and ownership is checked before setting SSE headers or subscribing to live events.

Only managed project directories under `PROJECTS_DIR` are eligible; imported folders and resolved paths that escape that root are refused. The child gets a per-run home and temp directory under `RUNTIME_DATA_DIR`, mode 0700, and an explicit environment with only `HOME`, `TMPDIR`, `TMP`, `TEMP` and `OD_DATA_DIR`. The root `OD_DATA_DIR` contract requires passing the resolved root to agent subprocesses. That reveals the root path to a same-UID child; a separate OS user/container boundary remains out of scope. No inherited provider, cloud, GitHub, token or API-key environment variables are passed.

The mock does not create or resume native provider sessions. A run must prove both project ownership and conversation membership before it can execute, and all resume-related request fields are refused. A planted foreign `agent_sessions` row is covered by the HTTP test. Future real provider resume must additionally key its persisted native session by actor and repeat this authorization at the resume lookup.

Cancellation targets only the selected run's child. Account session revocation, account deactivation, role changes and admin password resets cancel that account's active and queued mock runs through the auth route hook. On startup, rows left active by a prior daemon process become failed with their quota ledger entry closed; ordinary queued rows remain available for dispatch. Terminal rows are unchanged. See `web-multiuser-pool.md`.

## Remaining gates

- #11: real provider enrollment and credential isolation remain blocked; the test-mock pool proof is in `web-multiuser-pool.md`.
- #6: the bounded auth/admin/project-metadata shell is in `web-multiuser-web-ux.md`; conversation and run UX remain pending.
- #7/#8: deployment controls. This remains loopback-only and test-only.
- Native provider session ownership and process isolation for same-UID children need separate proof before real providers can run. A daemon crash can briefly leave a test mock child alive until its bounded delay ends; production process reaping must be included with provider enablement.
