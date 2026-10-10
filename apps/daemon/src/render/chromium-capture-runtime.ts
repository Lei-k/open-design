import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { chromium, type Browser, type CDPSession, type Page, type Route } from 'playwright-core';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import type { CaptureDebugger, CaptureImage, CaptureRect, CaptureRuntime, CaptureWindow, CaptureWindowOptions } from '@open-design/artifact-capture';

/**
 * Headless-Chromium implementation of the artifact capture runtime (#66).
 * The desktop drives the same pipeline with Electron; here every render page
 * is a fresh incognito context whose only network is:
 *   - the render entry document and same-render assets answered by
 *     `resolveAsset` (owner bytes the caller captured), and
 *   - GETs to a fixed allowlist of public font/CDN hosts (empty = none).
 * Everything else — loopback, private ranges, cloud metadata, other origins,
 * non-GET methods — is aborted before it leaves the browser.
 */

export const RENDER_ORIGIN = 'https://render.od.invalid';
export const DEFAULT_RENDER_ASSET_HOSTS = Object.freeze([
  'fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.tailwindcss.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
]);

export interface RenderAsset { body: Buffer; contentType: string }
export interface ChromiumCaptureOptions {
  /** Chromium/Chrome executable; omitted uses Playwright's managed browser. */
  executablePath?: string;
  /** Public hosts the page may GET (fonts, CSS/JS CDNs). */
  assetHosts?: readonly string[];
  /** Chromium's OS sandbox; disable only where the container cannot provide it. */
  sandbox?: boolean;
  /**
   * Run Chromium inside bubblewrap instead of its own sandbox (Alpine/musl
   * Chromium cannot run its seccomp sandbox). The launcher is written into
   * `launcherDir`; only system files and Chromium's own profile are mounted, and
   * the network namespace is unshared when no asset hosts are allowed.
   */
  bwrap?: { path: string; launcherDir: string };
  domToPptxBundlePath?: string;
}

// ---------------------------------------------------------------- images ---

function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(12) !== 0x49484452) throw new Error('not a PNG image');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function rgbaToBgra(rgba: Buffer): Buffer {
  const out = Buffer.allocUnsafe(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2]!; out[i + 1] = rgba[i + 1]!; out[i + 2] = rgba[i]!; out[i + 3] = rgba[i + 3]!;
  }
  return out;
}

/** Bilinear resample of a BGRA bitmap (used only to downscale stitched decks). */
function resizeBgra(src: Buffer, sw: number, sh: number, dw: number, dh: number): Buffer {
  const out = Buffer.alloc(dw * dh * 4);
  const xRatio = sw / dw; const yRatio = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * yRatio - 0.5); const y0 = Math.max(0, Math.floor(sy)); const y1 = Math.min(sh - 1, y0 + 1); const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x + 0.5) * xRatio - 0.5); const x0 = Math.max(0, Math.floor(sx)); const x1 = Math.min(sw - 1, x0 + 1); const fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c]!; const b = src[(y0 * sw + x1) * 4 + c]!;
        const d = src[(y1 * sw + x0) * 4 + c]!; const e = src[(y1 * sw + x1) * 4 + c]!;
        out[(y * dw + x) * 4 + c] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy);
      }
    }
  }
  return out;
}

/** NativeImage-compatible image: sizes and bitmaps are synchronous, encoders async. */
export class ServerCaptureImage implements CaptureImage {
  private bgra: Buffer | null;
  private constructor(private readonly size: { width: number; height: number }, private readonly png: Buffer | null, bgra: Buffer | null) {
    this.bgra = bgra;
  }
  static fromPng(png: Buffer): ServerCaptureImage { return new ServerCaptureImage(pngSize(png), png, null); }
  static fromBitmap(bgra: Buffer, size: { width: number; height: number }): ServerCaptureImage {
    return new ServerCaptureImage({ width: size.width, height: size.height }, null, bgra);
  }
  getSize() { return { ...this.size }; }
  toBitmap(): Buffer {
    if (!this.bgra) this.bgra = rgbaToBgra(PNG.sync.read(this.png!).data);
    return this.bgra;
  }
  private raw() {
    const { width, height } = this.size;
    return sharp(rgbaToBgra(this.toBitmap()), { raw: { width, height, channels: 4 } });
  }
  async toPNG(): Promise<Buffer> { return this.png ?? this.raw().png().toBuffer(); }
  async toJPEG(quality: number): Promise<Buffer> {
    return (this.png ? sharp(this.png) : this.raw()).flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
  }
  resize(options: { width?: number; height?: number }): CaptureImage {
    const width = Math.max(1, Math.round(options.width ?? this.size.width * ((options.height ?? this.size.height) / this.size.height)));
    const height = Math.max(1, Math.round(options.height ?? this.size.height * (width / this.size.width)));
    return ServerCaptureImage.fromBitmap(resizeBgra(this.toBitmap(), this.size.width, this.size.height, width, height), { width, height });
  }
}

// ---------------------------------------------------------------- window ---

type Listener = (...args: unknown[]) => void;

class ChromiumCaptureWindow implements CaptureWindow {
  private chain: Promise<unknown>;
  private destroyed = false;
  private readonly pageReady: Promise<Page>;
  private session: Promise<CDPSession> | null = null;
  private attached = false;
  private readonly once = new Map<string, Listener[]>();
  private entryHtml = '';
  readonly webContents: CaptureWindow['webContents'];

  constructor(browser: Browser, options: CaptureWindowOptions, private readonly resolveAsset: AssetResolver,
    private readonly assetHosts: ReadonlySet<string>) {
    this.pageReady = (async () => {
      const context = await browser.newContext({
        viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, javaScriptEnabled: true,
        acceptDownloads: false, serviceWorkers: 'block', bypassCSP: false, offline: false,
      });
      const page = await context.newPage();
      await context.route('**/*', (route) => this.route(route));
      page.on('domcontentloaded', () => this.emit('dom-ready'));
      // Popups never open; each is closed as soon as it appears.
      context.on('page', (popup) => { if (popup !== page) void popup.close(); });
      return page;
    })();
    this.chain = this.pageReady;
    const self = this;
    const dbg: CaptureDebugger = {
      attach() { self.attached = true; },
      detach() { self.attached = false; },
      isAttached() { return self.attached; },
      async sendCommand(method: string, params?: unknown) {
        const page = await self.settled();
        self.session ??= page.context().newCDPSession(page);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await self.session).send(method as any, params as any);
      },
    };
    this.webContents = {
      executeJavaScript: async (code: string) => (await this.settled()).evaluate(code),
      capturePage: async (rect?: CaptureRect) => {
        const page = await this.settled();
        const viewport = page.viewportSize() ?? { width: options.width, height: options.height };
        const clip = rect ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
        return ServerCaptureImage.fromPng(await page.screenshot({ clip, type: 'png', animations: 'allow', caret: 'initial' }));
      },
      debugger: dbg,
      once: (event: string, listener: Listener) => { this.once.set(event, [...(this.once.get(event) ?? []), listener]); },
      // Navigation never leaves the render entry (routes deny everything else).
      on: () => undefined,
      setWindowOpenHandler: () => undefined,
      stop: () => { void this.settled().then((page) => page.evaluate('window.stop()')).catch(() => undefined); },
    };
  }

  private emit(event: string): void {
    const listeners = this.once.get(event) ?? [];
    this.once.delete(event);
    for (const listener of listeners) listener();
  }

  /** Every operation runs after the previously queued window mutations. */
  private async settled(): Promise<Page> {
    if (this.destroyed) throw new Error('render window is destroyed');
    await this.chain;
    return this.pageReady;
  }
  private enqueue(operation: (page: Page) => Promise<unknown>): void {
    this.chain = this.chain.then(async () => operation(await this.pageReady)).catch(() => undefined);
  }

  private async route(route: Route): Promise<void> {
    const request = route.request();
    let url: URL;
    try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient'); }
    if (url.origin === RENDER_ORIGIN) {
      if (request.method() !== 'GET') return route.abort('blockedbyclient');
      if (url.pathname === '/__od_render__/entry.html') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: this.entryHtml });
      }
      const asset = await this.resolveAsset(url).catch(() => null);
      // Unknown renders and missing files are plain 404s; no other origin is consulted.
      return asset ? route.fulfill({ status: 200, contentType: asset.contentType, body: asset.body }) : route.fulfill({ status: 404, body: '' });
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.protocol === 'https:' && request.method() === 'GET' && this.assetHosts.has(url.hostname) && !url.port) return route.continue();
    return route.abort('blockedbyclient');
  }

  async loadURL(url: string): Promise<void> {
    // The pipeline hands documents over as data: URLs. They are served from the
    // render origin instead, so relative and base-href assets resolve through
    // the same deny-by-default router.
    const match = /^data:text\/html(?:;charset=[^,;]+)?,/i.exec(url);
    if (!match) throw new Error('render windows only load provided documents');
    this.entryHtml = decodeURIComponent(url.slice(match[0].length));
    const page = await this.settled();
    await page.goto(`${RENDER_ORIGIN}/__od_render__/entry.html`, { waitUntil: 'load', timeout: 30_000 });
  }
  setContentSize(width: number, height: number): void {
    this.enqueue((page) => page.setViewportSize({ width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }));
  }
  setOpacity(): void { /* headless pages always paint */ }
  showInactive(): void { /* headless pages always paint */ }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.pageReady.then((page) => page.context().close()).catch(() => undefined);
  }
}


const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** A launcher Playwright can exec: bubblewrap around Chromium with a minimal filesystem view. */
export async function writeSandboxedChromiumLauncher(input: { bwrapPath: string; chromiumPath: string; launcherDir: string; unshareNet: boolean }): Promise<string> {
  const chromium = await realpath(input.chromiumPath);
  const installDir = path.dirname(chromium);
  const binds = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/etc/fonts', '/var/cache/fontconfig', '/etc/ssl', '/etc/ca-certificates',
    '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/alpine-release', '/etc/os-release', '/etc/ld.so.cache']
    .map((target) => `--ro-bind-try ${target} ${target}`).join(' ');
  const script = `#!/bin/sh
# Generated by the Open Design daemon: Chromium for server-rendered exports,
# confined by bubblewrap. Only system files and this browser's own profile are
# visible; daemon data, projects and credentials are not mounted.
profile=""
for arg in "$@"; do case "$arg" in --user-data-dir=*) profile="\${arg#--user-data-dir=}";; esac; done
[ -n "$profile" ] && [ -d "$profile" ] || { echo "renderer: missing --user-data-dir" >&2; exit 64; }
exec ${shellQuote(input.bwrapPath)} --die-with-parent --new-session --unshare-pid --unshare-ipc --unshare-uts${input.unshareNet ? ' --unshare-net' : ''} \\
  ${binds} --ro-bind ${shellQuote(installDir)} ${shellQuote(installDir)} \\
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run --bind "$profile" "$profile" \\
  --setenv HOME /tmp --setenv TMPDIR /tmp \\
  -- ${shellQuote(chromium)} --no-sandbox "$@"
`;
  await mkdir(input.launcherDir, { recursive: true, mode: 0o700 });
  const launcher = path.join(input.launcherDir, 'chromium-sandboxed');
  await writeFile(launcher, script, { mode: 0o700 });
  await chmod(launcher, 0o700);
  return launcher;
}

// --------------------------------------------------------------- runtime ---

type AssetResolver = (url: URL) => Promise<RenderAsset | null>;

export interface RenderRegistration {
  /** Base href for the render document; assets under it resolve through `resolve`. */
  baseHref: string;
  dispose(): void;
}

export interface ChromiumCaptureHost {
  /** Installed process-wide via `setArtifactCaptureRuntime`; usable after `ready()`. */
  runtime: CaptureRuntime;
  /** Launches the browser once; rejects when Chromium is unavailable. */
  ready(): Promise<void>;
  /**
   * One render's private asset namespace. Concurrent renders never share a
   * resolver: the router dispatches on the render id in the request path.
   */
  register(resolve: (relativePath: string) => Promise<RenderAsset | null>): RenderRegistration;
  close(): Promise<void>;
}

export function createChromiumCaptureHost(options: ChromiumCaptureOptions = {}): ChromiumCaptureHost {
  let launching: Promise<Browser> | null = null;
  let browser: Browser | null = null;
  const renders = new Map<string, (relativePath: string) => Promise<RenderAsset | null>>();
  const hosts = new Set(options.assetHosts ?? DEFAULT_RENDER_ASSET_HOSTS);
  let bundle: Promise<string> | null = null;
  const resolveAsset: AssetResolver = async (url) => {
    const [, id, ...rest] = url.pathname.split('/');
    const resolver = id ? renders.get(id) : undefined;
    if (!resolver || rest.length === 0) return null;
    let relative: string;
    try { relative = rest.map((part) => decodeURIComponent(part)).join('/'); } catch { return null; }
    return resolver(relative);
  };
  const runtime: CaptureRuntime = {
    createWindow: (windowOptions) => {
      if (!browser) throw new Error('render browser is not ready');
      return new ChromiumCaptureWindow(browser, windowOptions, resolveAsset, hosts);
    },
    nativeImage: {
      createFromBuffer: (buffer) => ServerCaptureImage.fromPng(buffer),
      createFromBitmap: (bitmap, size) => ServerCaptureImage.fromBitmap(bitmap, size),
    },
    loadDomToPptxBundle: () => {
      const bundlePath = options.domToPptxBundlePath;
      if (!bundlePath) return Promise.reject(new Error('editable PPTX export is not configured on this server'));
      bundle ??= readFile(bundlePath).then((bytes) => (bundlePath.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'))
        .catch((error: unknown) => { bundle = null; throw error; });
      return bundle;
    },
  };
  return {
    runtime,
    async ready() {
      if (browser?.isConnected()) return;
      launching ??= (async () => {
        const executablePath = options.bwrap ? await writeSandboxedChromiumLauncher({ bwrapPath: options.bwrap.path,
          chromiumPath: options.executablePath ?? chromium.executablePath(), launcherDir: options.bwrap.launcherDir,
          unshareNet: hosts.size === 0 }) : options.executablePath;
        return chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        headless: true,
        // Under bubblewrap the outer sandbox replaces Chromium's own.
        chromiumSandbox: options.bwrap ? false : options.sandbox !== false,
        args: [
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          '--disable-background-networking', '--disable-sync', '--no-first-run', '--mute-audio', '--disable-dev-shm-usage',
        ],
        });
      })();
      try { browser = await launching; } finally { launching = null; }
      browser.on('disconnected', () => { browser = null; });
    },
    register(resolve) {
      const id = randomUUID();
      renders.set(id, resolve);
      return { baseHref: `${RENDER_ORIGIN}/${id}/`, dispose: () => { renders.delete(id); } };
    },
    async close() {
      const current = browser; browser = null;
      await current?.close().catch(() => undefined);
    },
  };
}
