import type { OpenDesignHostBridge } from './protocol.js';

type FunctionKeys<T> = { [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never }[keyof T];
export type StudioHostAction = {
  [K in keyof OpenDesignHostBridge]-?: K extends string
    ? `${K}.${FunctionKeys<NonNullable<OpenDesignHostBridge[K]>> & string}` : never
}[keyof OpenDesignHostBridge];

/** Closed condition vocabulary shared with the Web resolver. Adding a condition
 * requires a decision and tests rather than silently making it available. */
export const STUDIO_WEB_CONDITIONS = [
  'notification-api', 'notification-permission', 'clipboard-api', 'clipboard-rejected',
  'directory-api', 'download-blocked', 'renderer', 'popup-blocked', 'narrow-viewport',
  'site-data-blocked', 'project-permission', 'frame-lifecycle',
] as const;
export type StudioWebCondition = typeof STUDIO_WEB_CONDITIONS[number];
export const STUDIO_WEB_ACTION_CONDITIONS = {
  appearance: ['narrow-viewport'],
  'clear-data': ['site-data-blocked', 'narrow-viewport'],
  'rendered-export': ['renderer', 'download-blocked', 'narrow-viewport'],
  pet: ['narrow-viewport'],
  preview: ['frame-lifecycle', 'narrow-viewport'],
  directory: ['directory-api', 'narrow-viewport'],
  'file-upload': ['narrow-viewport'],
  'external-link': ['popup-blocked', 'narrow-viewport'],
  download: ['download-blocked', 'narrow-viewport'],
  about: ['narrow-viewport'],
  notifications: ['notification-api', 'notification-permission', 'narrow-viewport'],
  clipboard: ['clipboard-api', 'clipboard-rejected', 'narrow-viewport'],
  'public-link': ['narrow-viewport'],
  deploy: ['project-permission', 'narrow-viewport'],
} as const satisfies Record<string, readonly StudioWebCondition[]>;
export type StudioWebAction = keyof typeof STUDIO_WEB_ACTION_CONDITIONS;
/** Security ownership and observable Web handling for each condition. */
export const STUDIO_WEB_CONDITION_DECISIONS = {
  'notification-api': { owner: 'browser', handling: 'Keep control with unsupported reason; activity remains visible in Studio.', test: 'studio-capability-state' },
  'notification-permission': { owner: 'browser', handling: 'Prompt only on gesture; denial explains browser settings; never repeat dead prompts.', test: 'studio-capability-state' },
  'clipboard-api': { owner: 'browser', handling: 'Manual selectable text and legacy copy fallback; never report unobserved success.', test: 'studio-capability-state' },
  'clipboard-rejected': { owner: 'browser', handling: 'Show denial with selectable text when both copy mechanisms fail.', test: 'studio-capability-state' },
  'directory-api': { owner: 'browser', handling: 'Keep folder entry disabled with file/ZIP upload alternative.', test: 'studio-capability-state' },
  'download-blocked': { owner: 'browser', handling: 'Explain site download settings and retry; no API reliably observes completion.', test: 'studio-capability-state' },
  renderer: { owner: 'daemon', handling: 'Only authenticated renderedExports advertises renderer; keep PDF/PPTX/PNG with HTML/ZIP alternative.', test: 'studio-capability-state' },
  'popup-blocked': { owner: 'browser', handling: 'Validated HTTP(S) links with noopener/noreferrer and same-tab alternative; null is not proof of blocking.', test: 'studio-capability-state' },
  'narrow-viewport': { owner: 'browser', handling: 'Scrollable/reflowed controls and single-pane navigation; no device or user-agent gating.', test: 'studio-capability-state' },
  'site-data-blocked': { owner: 'browser', handling: 'Best-effort browser cleanup still revokes own server session; logout failure is visible.', test: 'studio-browser-data' },
  'project-permission': { owner: 'actor-project', handling: 'Owner-only deployment controls retain a localized denial; authenticated project access remains authoritative.', test: 'studio-deploy' },
  'frame-lifecycle': { owner: 'actor-project', handling: 'Existing bounded frame timeout diagnostics; no cross-origin compositor introspection.', test: 'studio-runtime' },
} as const satisfies Record<StudioWebCondition, { owner: string; handling: string; test: string }>;

export interface StudioHostParityDecision {
  issue: 60 | 66 | 67;
  strategy: 'browser' | 'daemon' | 'product-decision';
  equivalent: string;
  authority: 'actor' | 'actor-project' | 'public' | 'admin';
  /** Web condition policy; every bridge action must name a tested replacement. */
  webAction: StudioWebAction;
  /** Product-approved exclusion of the native action, not its Web replacement. */
  nativeApplicability?: 'not-applicable';
  productDecision?: string;
}

/** #52/#67 architectural decisions, NOT an advertisement of implemented features.
 * The mapped contract rejects additions to the bridge without a Web decision.
 * No host action is silently classified as Web-not-applicable.
 */
export const STUDIO_HOST_PARITY = {
  'appearance.setTheme': { webAction: 'appearance', issue: 67, strategy: 'browser', equivalent: 'Shared appearance store and document theme; actor preference adapter.', authority: 'actor' },
  'browser.clearData': { webAction: 'clear-data', issue: 67, strategy: 'browser', equivalent: 'Revoke own sessions, withdraw private tree, and clear only actor caches; never other tenants or server data.', authority: 'actor' },
  'capture.page': { webAction: 'rendered-export', issue: 66, strategy: 'daemon', equivalent: 'Isolated headless capture of an owned immutable artifact capability, with output limits and network deny-by-default.', authority: 'actor-project' },
  'pdf.print': { webAction: 'rendered-export', issue: 66, strategy: 'daemon', equivalent: 'Headless renderer against owned artifact snapshots; browser print for supported static documents.', authority: 'actor-project' },
  'pet.setVisible': { webAction: 'pet', issue: 67, strategy: 'browser', equivalent: 'In-page mascot with actor preference; the OS desktop overlay is Web-not-applicable by product approval.', authority: 'actor', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'preview.getLatestNavigationFailure': { webAction: 'preview', issue: 67, strategy: 'browser', equivalent: 'Frame load timeout and bounded capability-aware diagnostics; browser cannot inspect a cross-origin compositor.', authority: 'actor-project' },
  'preview.subscribeNavigationFailure': { webAction: 'preview', issue: 67, strategy: 'browser', equivalent: 'Session-bound frame lifecycle diagnostics; close all subscriptions on identity withdrawal.', authority: 'actor-project' },
  'project.pickAndImport': { webAction: 'directory', issue: 60, strategy: 'browser', equivalent: 'File/directory/ZIP upload into a new owned managed project; archive traversal, symlink, type and size controls.', authority: 'actor-project' },
  'project.pickAndReplaceWorkingDir': { webAction: 'directory', issue: 60, strategy: 'browser', equivalent: 'Owned replacement upload with backup/version recovery; never accept a daemon host path.', authority: 'actor-project' },
  'project.pickWorkingDir': { webAction: 'directory', issue: 60, strategy: 'browser', equivalent: 'Browser directory selection stages a bounded upload, not a server working-directory identifier.', authority: 'actor' },
  'shell.openExternal': { webAction: 'external-link', issue: 67, strategy: 'browser', equivalent: 'Validated HTTP(S) browser navigation with noopener and noreferrer; disallow arbitrary custom protocols.', authority: 'public' },
  'shell.openPath': { webAction: 'download', issue: 67, strategy: 'browser', equivalent: 'Download the owned project archive into the browser user\'s local workspace; never open shared daemon filesystem paths.', authority: 'actor-project' },
  'updater.check': { webAction: 'about', issue: 67, strategy: 'browser', equivalent: 'Public build-version check and reload availability; no daemon lifecycle privilege.', authority: 'public' },
  'updater.clear-cache': { webAction: 'clear-data', issue: 67, strategy: 'browser', equivalent: 'Clear only this browser actor cache; native package-cache mutation is Web-not-applicable and server deployment stays administrative.', authority: 'actor', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'updater.download': { webAction: 'about', issue: 67, strategy: 'browser', equivalent: 'Service build/version status and browser reload availability; local package downloading is Web-not-applicable.', authority: 'public', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'updater.install': { webAction: 'about', issue: 67, strategy: 'browser', equivalent: 'Browser reload for an updated service; local native app installation is Web-not-applicable and shared server deployment stays administrative.', authority: 'public', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'updater.quit': { webAction: 'clear-data', issue: 67, strategy: 'browser', equivalent: 'Logout and leave Studio without stopping the shared service; browser tab close remains user-controlled.', authority: 'actor' },
  'updater.setMenuLabels': { webAction: 'about', issue: 67, strategy: 'browser', equivalent: 'Shared localized Web navigation and update dialog labels; no native menu mutation.', authority: 'actor' },
  'updater.status': { webAction: 'about', issue: 67, strategy: 'browser', equivalent: 'Public current build and reload status; privileged deployment details require admin authority.', authority: 'public' },
  'updater.subscribe': { webAction: 'about', issue: 67, strategy: 'browser', equivalent: 'Public build polling with teardown on navigation; never global operational event streams.', authority: 'public' },
  'updater.subscribeOpenDialog': { webAction: 'about', issue: 67, strategy: 'browser', equivalent: 'Shared Web update dialog state; actor generation owns subscriptions and dismissal.', authority: 'actor' },
} as const satisfies Record<StudioHostAction, StudioHostParityDecision>;
