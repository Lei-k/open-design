import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, nativeImage, type BrowserWindowConstructorOptions } from "electron";
import {
  loadFirstDomToPptxBundle,
  setArtifactCaptureRuntime,
  type CaptureImage,
  type CaptureWindow,
} from "@open-design/artifact-capture";

// The capture pipeline lives in @open-design/artifact-capture so the daemon's
// headless renderer shares it. The desktop drives it with real Electron
// windows and native images.
export * from "@open-design/artifact-capture";

const here = path.dirname(fileURLToPath(import.meta.url));

setArtifactCaptureRuntime({
  createWindow: (options) => new BrowserWindow(options as BrowserWindowConstructorOptions) as unknown as CaptureWindow,
  nativeImage: {
    createFromBuffer: (buffer) => nativeImage.createFromBuffer(buffer) as CaptureImage,
    createFromBitmap: (bitmap, size) => nativeImage.createFromBitmap(bitmap, size) as CaptureImage,
  },
  // Vendored dom-to-pptx browser UMD (apps/desktop/vendor/dom-to-pptx). The
  // packaged app ships it via electron-builder `extraResources` under
  // Resources/ (`process.resourcesPath`); dev resolves it from apps/desktop/vendor.
  loadDomToPptxBundle: (() => {
    let cached: Promise<string> | null = null;
    return () => {
      const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      cached ??= loadFirstDomToPptxBundle([
        ...(resourcesPath
          ? [path.join(resourcesPath, "dom-to-pptx.bundle.js.gz"), path.join(resourcesPath, "dom-to-pptx.bundle.js")]
          : []),
        path.resolve(here, "../../vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz"),
        path.resolve(here, "../../vendor/dom-to-pptx/dom-to-pptx.bundle.js"),
        path.resolve(here, "../../../vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz"),
        path.resolve(here, "../../../vendor/dom-to-pptx/dom-to-pptx.bundle.js"),
        path.resolve(here, "dom-to-pptx.bundle.js.gz"),
        path.resolve(here, "dom-to-pptx.bundle.js"),
      ]).catch((error: unknown) => { cached = null; throw error; });
      return cached;
    };
  })(),
});
