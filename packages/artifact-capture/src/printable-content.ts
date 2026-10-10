import type { CaptureWindow as BrowserWindow } from "./runtime.js";

// Bounded wait for a render document's fonts, images and first-viewport
// resources before capture or print. Shared by the desktop (Electron) and
// daemon (headless Chromium) capture runtimes.

export const PRINTABLE_CONTENT_WAIT_TIMEOUT_MS = 15_000;

/**
 * Per-resource ceiling inside the page, kept below the outer bound so a single
 * stalled image drops out while the rest of the document still settles
 * normally, instead of every export paying the full outer timeout.
 *
 * Derived rather than hard-coded so a caller on a tighter budget (the chat
 * card's first-viewport thumbnail spends 5s where an export spends 15s) keeps
 * the same inner/outer relationship instead of accidentally inverting it and
 * making every resource pay the whole budget. At the default budget this is
 * exactly the 10s it has always been.
 */
export function inPageResourceBudget(budgetMs: number): number {
  return Math.max(1_000, Math.round((budgetMs * 2) / 3));
}

export type PrintableContentWaitOptions = {
  /** Total ceiling for this wait. Defaults to {@link PRINTABLE_CONTENT_WAIT_TIMEOUT_MS}. */
  budgetMs?: number;
  /**
   * Only wait for resources that intersect the first viewport.
   *
   * An export renders the whole document, so it has to wait for the whole
   * document. A first-viewport cover does not: waiting on the 200th image of a
   * long page cannot change a single pixel of the shot, it just spends the
   * thumbnail's (much tighter) budget. Off by default — every existing caller
   * keeps waiting for everything.
   */
  firstViewportOnly?: boolean;
};

/**
 * Does `rect` overlap the first viewport of a `viewportHeight`-tall window?
 *
 * Serialized into the page, so it stays dependency-free. A zero-height element
 * sitting at the top counts as visible: an `<img>` that has not loaded yet
 * frequently lays out with no height, and it is precisely the thing the cover
 * is waiting for.
 */
export function intersectsFirstViewport(
  rect: { bottom: number; top: number },
  viewportHeight: number,
): boolean {
  return rect.top < viewportHeight && rect.bottom >= 0;
}

export async function waitForPrintableContent(
  window: BrowserWindow,
  options?: PrintableContentWaitOptions,
): Promise<void> {
  const budgetMs =
    typeof options?.budgetMs === "number" && Number.isFinite(options.budgetMs) && options.budgetMs > 0
      ? options.budgetMs
      : PRINTABLE_CONTENT_WAIT_TIMEOUT_MS;
  const pageSettled = window.webContents.executeJavaScript(
    `(function() {
      var RESOURCE_TIMEOUT_MS = ${inPageResourceBudget(budgetMs)};
      var FIRST_VIEWPORT_ONLY = ${options?.firstViewportOnly === true};
      var ${intersectsFirstViewport.name} = ${intersectsFirstViewport.toString()};

      // Scope gate. With FIRST_VIEWPORT_ONLY off this is the identity filter,
      // so an export's resource set is byte-for-byte what it always was.
      function inCaptureScope(el) {
        if (!FIRST_VIEWPORT_ONLY) return true;
        try {
          return ${intersectsFirstViewport.name}(
            el.getBoundingClientRect(),
            window.innerHeight || document.documentElement.clientHeight || 0
          );
        } catch (e) {
          // Unmeasurable (detached, or a stub surface): keep it rather than
          // silently skipping a resource the shot may need.
          return true;
        }
      }

      // Resolve-on-timeout (never reject): a resource we gave up on is treated
      // exactly like one that fired 'error' — the capture proceeds without it.
      // Count the ones we abandoned so the main process can tell "everything
      // loaded" from "we stopped waiting", which decides whether the still
      // in-flight requests need cancelling.
      var stalledCount = 0;
      function withDeadline(promise) {
        return Promise.race([
          promise,
          new Promise(function(resolve) {
            setTimeout(function() { stalledCount += 1; resolve(); }, RESOURCE_TIMEOUT_MS);
          })
        ]);
      }

      function waitForImages() {
        return Promise.all(Array.from(document.images || []).filter(inCaptureScope).map(function(img) {
          if (img.complete) return Promise.resolve();
          return withDeadline(new Promise(function(resolve) {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }));
        }));
      }

      function cssUrlValues(value) {
        var urls = [];
        if (!value || value === 'none') return urls;
        value.replace(/url\\((['"]?)(.*?)\\1\\)/g, function(_, _quote, rawUrl) {
          if (rawUrl && !/^data:/i.test(rawUrl)) urls.push(rawUrl);
          return '';
        });
        return urls;
      }

      function waitForCssBackgroundImages() {
        var urls = new Set();
        Array.from(document.querySelectorAll('*')).filter(inCaptureScope).forEach(function(el) {
          var style = window.getComputedStyle(el);
          cssUrlValues(style.backgroundImage).forEach(function(url) { urls.add(url); });
          cssUrlValues(style.borderImageSource).forEach(function(url) { urls.add(url); });
          cssUrlValues(style.listStyleImage).forEach(function(url) { urls.add(url); });
        });
        return Promise.all(Array.from(urls).map(function(url) {
          return withDeadline(new Promise(function(resolve) {
            var img = new Image();
            img.onload = resolve;
            img.onerror = resolve;
            img.src = url;
          }));
        }));
      }

      function nextFrame() {
        return new Promise(function(resolve) { requestAnimationFrame(function() { resolve(true); }); });
      }

      return Promise.all([
        document.fonts && document.fonts.ready
          ? withDeadline(document.fonts.ready.catch(function(){}))
          : Promise.resolve(),
        waitForImages(),
        waitForCssBackgroundImages()
      ])
        .then(nextFrame)
        .then(nextFrame)
        .then(function(){ return { stalled: stalledCount > 0 }; });
    })()`,
    true,
  ) as Promise<unknown>;

  // Outer backstop for the case the in-page bound can never fire: a renderer
  // whose event loop is wedged never runs our setTimeout either, and
  // executeJavaScript itself stays pending. Resolve rather than reject, for
  // the same reason the in-page bound does.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const OUTER_TIMEOUT = Symbol("printable-content-outer-timeout");
  let raced: unknown;
  try {
    raced = await Promise.race([
      pageSettled,
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(OUTER_TIMEOUT), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // Did we stop waiting on anything? Either layer counts:
  //   - outer: the renderer never answered at all, so its event loop is wedged;
  //   - in-page: the script came back on time but abandoned some resource.
  // The in-page case is the ordinary stalled-network one — the renderer is
  // healthy, so the page-side deadline fires first and the outer timer never
  // runs. Keying only off the outer timer would skip cancellation in exactly
  // that case and leave the requests in flight.
  const inPageStalled =
    typeof raced === "object" && raced !== null && (raced as { stalled?: unknown }).stalled === true;
  const gaveUp = raced === OUTER_TIMEOUT || inPageStalled;

  // Giving up on the wait is not enough on its own: the requests we stopped
  // waiting for are still in flight, and every later `executeJavaScript` in
  // the capture pipeline queues behind a renderer that is still busy with
  // them. Measured on a document whose <img> and CSS url() both point at a
  // socket that never answers, the steps AFTER this one cost 15340ms +
  // 22459ms without this, and 6ms + 10566ms with it. Cancelling the
  // outstanding loads hands the renderer back; the document is already
  // parsed, so nothing that has rendered is lost.
  if (gaveUp) {
    try {
      window.webContents.stop();
    } catch {
      // A destroyed webContents means the export is being torn down anyway.
    }
  }
}

