ARG NODE_IMAGE=docker.io/library/node:24-alpine
ARG RUNTIME_IMAGE=docker.io/library/node:24-alpine

FROM ${NODE_IMAGE} AS build

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NO_PROXY

ENV HTTP_PROXY=${HTTP_PROXY}
ENV HTTPS_PROXY=${HTTPS_PROXY}
ENV http_proxy=${http_proxy}
ENV https_proxy=${https_proxy}
ENV no_proxy=${no_proxy}
ENV NO_PROXY=${NO_PROXY}
ENV CI=true
# onnxruntime-node (via hyperframes) otherwise downloads its CUDA provider
# libraries (hundreds of MB) during postinstall. The alpine runtime has no GPU,
# so they are dead weight in the image, and on slow links the download stalls
# the whole build.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip

RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts/postinstall.mjs ./scripts/
COPY packages ./packages
COPY tools ./tools
COPY apps/daemon/package.json ./apps/daemon/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY e2e/package.json ./e2e/package.json
RUN corepack enable && \
    corepack prepare pnpm@10.33.2 --activate && \
    pnpm install --frozen-lockfile

COPY apps ./apps
# The daemon and web TypeScript builds exceed Node's default heap; the limit is
# scoped to this step (the runtime stage sets its own NODE_OPTIONS).
RUN export NODE_OPTIONS=--max-old-space-size=6144 && \
    pnpm --filter @open-design/daemon build && \
    pnpm --filter @open-design/web build && \
    pnpm --filter @open-design/daemon deploy --legacy --prod /app/deploy/daemon && \
    pnpm store prune && \
    rm -rf \
      /root/.cache \
      /root/.local/share/pnpm/store \
      /app/deploy/daemon/node_modules/.cache \
      /app/deploy/daemon/node_modules/@types \
      /app/deploy/daemon/node_modules/.pnpm/@types+* \
      /app/deploy/daemon/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/deps \
      /app/deploy/daemon/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/src && \
    find /app/deploy/daemon/node_modules -type d \( \
      -name test -o \
      -name tests -o \
      -name "__tests__" -o \
      -name docs -o \
      -name doc -o \
      -name example -o \
      -name examples -o \
      -name ".github" \
    \) -prune -exec rm -rf '{}' + && \
    find /app/deploy/daemon/node_modules -type f \( \
      -name "*.md" -o \
      -name "*.markdown" -o \
      -name "*.d.ts" -o \
      -name "*.d.cts" -o \
      -name "*.d.mts" -o \
      -name "*.map" -o \
      -name "*.tsbuildinfo" -o \
      -name "binding.gyp" \
    \) -delete

# Stage-2 assets — copied into the build stage so the runtime stage
# can pull them via --from=build instead of reaching back into the
# build context.  This lets the Dockerfile work when the build context
# differs from the repo root (Railway, CI runners with a subdirectory
# context, etc.).
COPY skills ./skills
COPY design-systems ./design-systems
COPY craft ./craft
COPY prompt-templates ./prompt-templates
COPY assets ./assets
# `data/plugin-previews/manifest.json` is committed by the bake pipeline and is
# what `resolvePluginPreviewsDir()` looks for at runtime. Without it in the
# image, `loadManifest()` returns `{}` and every plugin silently falls back to
# the live-iframe preview path — the exact cost the bakes exist to avoid.
COPY data ./data
COPY plugins/_official ./plugins/_official

FROM ${RUNTIME_IMAGE} AS runtime

RUN apk add --no-cache tini poppler-utils bash git && \
    addgroup -S -g 1001 open-design && \
    adduser -S -D -H -u 1001 -G open-design open-design

WORKDIR /app
COPY --from=build --chown=open-design:open-design /app/deploy/daemon ./apps/daemon
COPY --from=build --chown=open-design:open-design /app/apps/web/out ./apps/web/out
COPY --from=build --chown=open-design:open-design /app/skills ./skills
COPY --from=build --chown=open-design:open-design /app/design-systems ./design-systems
COPY --from=build --chown=open-design:open-design /app/craft ./craft
COPY --from=build --chown=open-design:open-design /app/prompt-templates ./prompt-templates
COPY --from=build --chown=open-design:open-design /app/data ./data
COPY --from=build --chown=open-design:open-design /app/assets/frames ./assets/frames
COPY --from=build --chown=open-design:open-design /app/assets/community-pets ./assets/community-pets
# Plan §3.J4 / spec §23.3.5 — bundled atom plugins registered on
# daemon boot. The directory contains `plugins/_official/atoms/<atom>/`
# pairs (SKILL.md + open-design.json); registerBundledPlugins() walks
# it on startup so the container ships with first-party atoms reachable
# via the same registry path third-party plugins use.
COPY --from=build --chown=open-design:open-design /app/plugins/_official ./plugins/_official

RUN mkdir -p /app/.od && \
    chown -R open-design:open-design /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=192
ENV OD_BIND_HOST=0.0.0.0
ENV OD_PORT=7456

EXPOSE 7456

USER open-design
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/daemon/dist/cli.js", "--no-open"]

# ---------------------------------------------------------------------------
# Multi-user staging target (#7/#18): `docker build --target multiuser`.
# Starts `multiuser-serve` behind the HTTPS proxy in deploy/multiuser/, with a
# pinned real Codex CLI for personal subscriptions; every personal Codex child
# runs in a per-run bubblewrap sandbox. The default target stays single-user.
#
# The CLI comes from the official release, verified by sha256. A local build
# can supply an already-verified standalone release directory instead:
#   --build-context codex-release=<dir containing bin/codex>
FROM ${NODE_IMAGE} AS codex-download
ARG CODEX_VERSION=0.154.0
ARG CODEX_SHA256=d7e18b2597ae8f242f5f31ee9e90deef48dbc9edd634d9868fb6435d08c07f02
RUN set -eu; \
    [ "$(uname -m)" = "x86_64" ] || { echo "the multiuser target pins the x86_64 Codex release" >&2; exit 1; }; \
    mkdir -p /out/bin; \
    wget -qO /tmp/codex.tgz "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-x86_64-unknown-linux-musl.tar.gz"; \
    echo "${CODEX_SHA256}  /tmp/codex.tgz" | sha256sum -c -; \
    tar -xzf /tmp/codex.tgz -C /tmp; \
    mv /tmp/codex-x86_64-unknown-linux-musl /out/bin/codex; \
    chmod 0755 /out/bin/codex

FROM scratch AS codex-release
COPY --from=codex-download /out/ /

FROM runtime AS multiuser
USER root
# chromium + fonts: server-rendered PDF/PPTX/PNG exports (#66). CJK and emoji
# fonts keep Chinese/Japanese/Korean artifacts from rendering as tofu.
RUN apk add --no-cache bubblewrap ca-certificates chromium font-noto font-noto-cjk font-noto-emoji
COPY --from=codex-release / /opt/codex/
RUN chmod -R a+rX /opt/codex && /opt/codex/bin/codex --version
# Editable PPTX engine (vendored browser bundle) for the export renderer.
COPY --from=build --chown=open-design:open-design /app/apps/desktop/vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz /opt/open-design/dom-to-pptx.bundle.js.gz
# The daemon binds loopback only; the proxy shares this network namespace.
ENV OD_BIND_HOST=127.0.0.1
ENV NODE_OPTIONS=--max-old-space-size=1024
# Daemon data root: root AGENTS.md "Daemon data directory contract". The
# launcher requires it explicitly; this image keeps the single-user mount point.
ENV OD_DATA_DIR=/app/.od
USER open-design
CMD ["node", "apps/daemon/dist/multiuser-serve.js", "--config", "/etc/open-design/multiuser.json"]

# The default target: the single-user daemon, unchanged.
FROM runtime AS single-user
