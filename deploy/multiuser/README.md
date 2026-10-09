# Multi-user staging deployment

This directory runs OpenDesign in **multi-user mode** on one host, for staging (#7, #18; owner decisions of 2026-10-06). It is not launch approval: the cross-account launch gate (#8) is not done.

What a deployment gets:

- Username/password sign-in, an admin area for accounts and audit, and private design projects, conversations, generated files, and previews per user.
- **Personal Codex subscriptions.** Each user links their own ChatGPT plan through the official Codex device-code login and runs Codex on it. Every Codex child runs in a per-run bubblewrap sandbox.
- **Provider sources.** Besides personal subscriptions, an administrator can configure the shared OpenAI company pool (Admin → pool: model, capacity and the server-held API key), and each user can save their own OpenAI key in Settings → Agent accounts and run on it. A user's own key is write-only and never readable by an administrator. Real-provider acceptance for both is still outstanding (#14).

Single-user Docker deployment is `../docker-compose.yml`. Do not mix the two: the single-user daemon's shared `OD_API_TOKEN` is not per-user authorization, and the multi-user launcher refuses to start next to it.

## Topology

```
browser ──HTTPS──▶ app origin ──┐
                               ├─ caddy ──http://127.0.0.1:7456──▶ od
preview iframe ──▶ preview origin┘
```

- `od` runs `node apps/daemon/dist/multiuser-serve.js --config /etc/open-design/multiuser.json`. The daemon binds `127.0.0.1` only.
- `caddy` shares `od`'s network namespace (`network_mode: service:od`). It obtains certificates for `OD_DOMAIN` and `OD_PREVIEW_DOMAIN` and is the only listener on ports 80 and 443. The daemon serves only sandboxed preview capabilities on the preview host and never serves login or ordinary APIs there.
- Nothing else can reach the daemon, not even other containers on the host.
- Sign-in cookies are `__Host-` and always `Secure`, so the site works only over HTTPS on the configured origin.

## Host prerequisites

- An x86_64 Linux host with Docker Engine and the Compose plugin.
- A DNS name whose A/AAAA record points at the host, with ports 80 and 443 open to the internet (Let's Encrypt validation).
- Unprivileged user namespaces available to the container, needed for the personal-subscription sandbox:
  - `sysctl kernel.unprivileged_userns_clone` must not be `0` on kernels that have it.
  - On Ubuntu 23.10 and later, `kernel.apparmor_restrict_unprivileged_userns=1` also blocks it. Set it to `0`, or provide an AppArmor profile that allows user namespaces.
  - If the sandbox cannot be built, the daemon refuses to start and says so. It never runs Codex unsandboxed.
- An encrypted volume for Docker's data (for example an encrypted EBS volume). Provider credentials are files the Codex CLI reads in plain text; encryption at rest is the deployment's job.

## First deployment

1. **Config.** Copy `multiuser.example.json` to `multiuser.json`.
   - Set `publicOrigin` to `https://<your domain>`, with the same host as `OD_DOMAIN` and no path.
   - Create a second DNS A/AAAA record for the preview host, set `previewOrigin` to its exact HTTPS origin, and put the same host in `.env` as `OD_PREVIEW_DOMAIN` (step 3). It must use a different hostname from `publicOrigin`; changing only the port would still send host cookies.
   - Keep `acknowledge` exactly as written. It records that this is a staging deployment.
   - To run without personal subscriptions, remove `personalCodex`. Then also remove the three `*=unconfined` entries from `security_opt` in `docker-compose.yml`.
   - `renderer` enables server-rendered PDF, PPTX and PNG exports in Studio (Chromium is in the image). Each render runs in a fresh headless browser context that can reach only the captured project bytes and GETs to a fixed list of public font/CDN hosts (Google Fonts, Tailwind CDN, jsDelivr, unpkg, cdnjs). Set `"assetHosts": []` to block those too (artifacts that load fonts or CSS from a CDN then render without them), or list your own hosts. The image's Alpine Chromium cannot run its own seccomp sandbox, so `bwrap` confines it with bubblewrap instead (the same unprivileged user namespaces as the personal-subscription sandbox): only system files and the browser's own profile are mounted — no daemon data, projects or credentials — and with `"assetHosts": []` it has no network namespace at all. Remove `renderer` to turn rendered exports off; the Export menu then offers HTML, Markdown and ZIP only.
2. **Bootstrap secret** for the first administrator. It must be at least 32 characters, and the container user (uid 1001) must be able to read it:
   ```sh
   openssl rand -hex 32 > secrets/bootstrap
   sudo chown 1001:1001 secrets/bootstrap && sudo chmod 400 secrets/bootstrap
   ```
3. **Environment.** Copy `.env.example` to `.env` and set `OD_DOMAIN` and
   `OD_PREVIEW_DOMAIN` to the two hosts from step 1. Compose reads this file for
   every command, `docker compose build` included, and refuses to run without
   those two values.
   ```sh
   cp .env.example .env
   ${EDITOR:-nano} .env
   ```
4. **Start.**
   ```sh
   docker compose up -d
   docker compose logs -f od   # expect: "multi-user staging daemon listening on http://127.0.0.1:7456 for https://<domain>"
   ```
5. **Create the first administrator.** There is no web form for this. Call the one-time bootstrap endpoint through the public HTTPS origin; the password must be at least 12 characters:
   ```sh
   curl -sS -X POST "https://$OD_DOMAIN/api/auth/bootstrap" \
     -H "Origin: https://$OD_DOMAIN" -H 'Content-Type: application/json' \
     -d "{\"bootstrapToken\":\"$(sudo cat secrets/bootstrap)\",\"username\":\"admin\",\"password\":\"<a long password>\"}"
   ```
   It answers `201` once; every later call is refused. Then remove `bootstrapSecretFile` from `multiuser.json`, delete `secrets/bootstrap`, and run `docker compose up -d` again. Sign in at `https://<your domain>/login`.
6. **Add users** in Admin → Users. Each user sets their own password through the one-use link the admin hands over. There is no public registration.
7. **Personal subscriptions.** Each user opens Settings → Agent accounts → Codex → Link my subscription, and completes the device-code sign-in on the official OpenAI page. ChatGPT may require device-code sign-in to be enabled in the user's security settings or by their workspace admin. Verification runs one minimal turn on the user's own plan, and only after explicit consent.

## Two-account staging acceptance

Before inviting anyone beyond the deployment owner, complete the #48/#8 gate with two platform accounts and two separately authorized Codex subscriptions:

1. In each account, create a project and a design conversation, choose a built-in skill and design system, answer a question form, generate an HTML prototype, preview it, request a revision, and preview the revision on desktop and mobile.
2. From account A, try account B's project, conversation, run, file-content, preview-URL, preview-renewal, and preview-capability paths. Repeat B → A. Every request must return the same not-found response and must not change either account's data.
3. In a generated preview, attempt an app API fetch, cookie access, form submission, and top-level navigation. The preview must remain on the dedicated preview origin; CSP and the opaque-origin iframe must block all four attempts.
4. Unlink or re-authorize one Codex account and confirm that its earlier preview URL no longer opens. Sign out and confirm the same. A newly issued preview URL must still work after signing back in.
5. Save the exact steps, browser/device versions, results, and desktop/mobile screenshots on issue #48. Any failure gets its own issue; do not treat this checklist itself as launch approval.

## Image

- `docker compose build` builds `deploy/Dockerfile --target multiuser`. Without a build, Compose pulls `${OPEN_DESIGN_MULTIUSER_IMAGE:-neil0628/open-design:multiuser-latest}`.
- The image pins the official Codex release (`CODEX_VERSION`, verified by `CODEX_SHA256`) at `/opt/codex/bin/codex`, plus `bubblewrap` and CA certificates.
- The per-run bubblewrap filesystem is the personal run's command boundary. Inside it, OpenDesign disables Codex's redundant nested Linux sandbox so file tools work on unprivileged container hosts. The child can still write only its own `CODEX_HOME`, run home/temp, and project; the daemon data and every other account remain outside its filesystem.
- A local build can use an already-installed standalone release instead of downloading: `--build-context codex-release=<dir containing bin/codex>`.

## Backups, restore and revocation

- Back up the `od_data` volume. Data paths inside it follow the root `AGENTS.md` "Daemon data directory contract".
- **Exclude provider homes from backups.** These are every `codex-home`, `codex-home.previous` and `codex-login-*` directory under `multiuser-runtime/`; see `specs/current/web-multiuser-personal-subscription.md`. After a restore, linked accounts show "Sign-in expired", and each user re-authorizes. Nothing falls back to another account or the company pool.
- **Unlink** deletes the user's local Codex sign-in only. To revoke it at OpenAI too, the user signs out of all devices in ChatGPT security settings; the unlink confirmation says so.
- **Deactivating a user** (Admin → Users) ends their sessions and cancels their queued and running runs.

## Upgrades

Pull or build the new image and run `docker compose up -d`. Queued runs survive a restart; running runs are canceled at shutdown. Database schema migrations run on start and are covered by the daemon's own tests. Take a backup first.

## Known limits

- One host and one daemon process. No horizontal scaling.
- Company pool off until #14.
- PDF/PPTX/PNG exports are rasterized (one image per slide or viewport), like the desktop's default export.
- The cross-account end-to-end and browser regression gate (#8) is run on this deployment after it is up.
