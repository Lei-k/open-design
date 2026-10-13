/**
 * The browser surface the artifact capture pipeline drives. It is the subset
 * of Electron's BrowserWindow / NativeImage the desktop renderer has always
 * used, so the desktop passes real Electron objects and the daemon passes a
 * headless-Chromium adapter. Image encoders may be asynchronous; capture code
 * always awaits them.
 */
export interface CaptureImage {
  getSize(): { width: number; height: number };
  toPNG(): Buffer | Promise<Buffer>;
  toJPEG(quality: number): Buffer | Promise<Buffer>;
  /** Raw BGRA pixels, rows top to bottom (synchronous: paint checks are predicates). */
  toBitmap(): Buffer;
  resize(options: { width?: number; height?: number }): CaptureImage;
}

export interface CaptureDebugger {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendCommand(method: string, params?: any): Promise<any>;
}

export interface CaptureRect { x: number; y: number; width: number; height: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface CaptureWebContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<any>;
  capturePage(rect?: CaptureRect): Promise<CaptureImage>;
  debugger: CaptureDebugger;
  once(event: any, listener: any): any;
  on(event: any, listener: any): any;
  setWindowOpenHandler(handler: any): any;
  stop(): void;
}

export interface CaptureWindow {
  webContents: CaptureWebContents;
  loadURL(url: string): Promise<unknown>;
  setContentSize(width: number, height: number): void;
  setOpacity(opacity: number): void;
  showInactive(): void;
  isDestroyed(): boolean;
  destroy(): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface CaptureWindowOptions {
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface CaptureRuntime {
  createWindow(options: CaptureWindowOptions): CaptureWindow;
  nativeImage: {
    createFromBuffer(buffer: Buffer): CaptureImage;
    createFromBitmap(bitmap: Buffer, size: { width: number; height: number }): CaptureImage;
  };
  /** The vendored dom-to-pptx browser bundle for editable PPTX; rejects when not shipped. */
  loadDomToPptxBundle(): Promise<string>;
}

let current: CaptureRuntime | null = null;

/** Each host (desktop main process, daemon) installs its runtime once at startup. */
export function setArtifactCaptureRuntime(runtime: CaptureRuntime): void {
  current = runtime;
}

export function artifactCaptureRuntime(): CaptureRuntime {
  if (!current) throw new Error("artifact capture runtime is not configured");
  return current;
}
