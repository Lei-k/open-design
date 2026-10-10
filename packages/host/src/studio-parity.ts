import type { OpenDesignHostBridge } from './protocol.js';

type FunctionKeys<T> = { [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never }[keyof T];
export type StudioHostAction = {
  [K in keyof OpenDesignHostBridge]-?: K extends string
    ? `${K}.${FunctionKeys<NonNullable<OpenDesignHostBridge[K]>> & string}` : never
}[keyof OpenDesignHostBridge];

export interface StudioHostParityDecision {
  issue: 60 | 66 | 67;
  strategy: 'browser' | 'daemon' | 'product-decision';
  equivalent: string;
  authority: 'actor' | 'actor-project' | 'public' | 'admin';
  /** Product-approved exclusion of the native action, not its Web replacement. */
  nativeApplicability?: 'not-applicable';
  productDecision?: string;
}

/** #52/#67 architectural decisions, NOT an advertisement of implemented features.
 * The mapped contract rejects additions to the bridge without a Web decision.
 * No host action is silently classified as Web-not-applicable.
 */
export const STUDIO_HOST_PARITY = {
  'appearance.setTheme': { issue: 67, strategy: 'browser', equivalent: 'Shared appearance store and document theme; actor preference adapter.', authority: 'actor' },
  'browser.clearData': { issue: 67, strategy: 'browser', equivalent: 'Revoke own sessions, withdraw private tree, and clear only actor caches; never other tenants or server data.', authority: 'actor' },
  'capture.page': { issue: 66, strategy: 'daemon', equivalent: 'Isolated headless capture of an owned immutable artifact capability, with output limits and network deny-by-default.', authority: 'actor-project' },
  'pdf.print': { issue: 66, strategy: 'daemon', equivalent: 'Headless renderer against owned artifact snapshots; browser print for supported static documents.', authority: 'actor-project' },
  'pet.setVisible': { issue: 67, strategy: 'browser', equivalent: 'In-page mascot with actor preference; the OS desktop overlay is Web-not-applicable by product approval.', authority: 'actor', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'preview.getLatestNavigationFailure': { issue: 67, strategy: 'browser', equivalent: 'Frame load timeout and bounded capability-aware diagnostics; browser cannot inspect a cross-origin compositor.', authority: 'actor-project' },
  'preview.subscribeNavigationFailure': { issue: 67, strategy: 'browser', equivalent: 'Session-bound frame lifecycle diagnostics; close all subscriptions on identity withdrawal.', authority: 'actor-project' },
  'project.pickAndImport': { issue: 60, strategy: 'browser', equivalent: 'File/directory/ZIP upload into a new owned managed project; archive traversal, symlink, type and size controls.', authority: 'actor-project' },
  'project.pickAndReplaceWorkingDir': { issue: 60, strategy: 'browser', equivalent: 'Owned replacement upload with backup/version recovery; never accept a daemon host path.', authority: 'actor-project' },
  'project.pickWorkingDir': { issue: 60, strategy: 'browser', equivalent: 'Browser directory selection stages a bounded upload, not a server working-directory identifier.', authority: 'actor' },
  'shell.openExternal': { issue: 67, strategy: 'browser', equivalent: 'Validated HTTP(S) browser navigation with noopener and noreferrer; disallow arbitrary custom protocols.', authority: 'public' },
  'shell.openPath': { issue: 67, strategy: 'browser', equivalent: 'Download the owned project archive into the browser user\'s local workspace; never open shared daemon filesystem paths.', authority: 'actor-project' },
  'updater.check': { issue: 67, strategy: 'browser', equivalent: 'Public build-version check and reload availability; no daemon lifecycle privilege.', authority: 'public' },
  'updater.clear-cache': { issue: 67, strategy: 'browser', equivalent: 'Clear only this browser actor cache; native package-cache mutation is Web-not-applicable and server deployment stays administrative.', authority: 'actor', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'updater.download': { issue: 67, strategy: 'browser', equivalent: 'Service build/version status and browser reload availability; local package downloading is Web-not-applicable.', authority: 'public', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'updater.install': { issue: 67, strategy: 'browser', equivalent: 'Browser reload for an updated service; local native app installation is Web-not-applicable and shared server deployment stays administrative.', authority: 'public', nativeApplicability: 'not-applicable', productDecision: '#67: user approval, 2026-10-07' },
  'updater.quit': { issue: 67, strategy: 'browser', equivalent: 'Logout and leave Studio without stopping the shared service; browser tab close remains user-controlled.', authority: 'actor' },
  'updater.setMenuLabels': { issue: 67, strategy: 'browser', equivalent: 'Shared localized Web navigation and update dialog labels; no native menu mutation.', authority: 'actor' },
  'updater.status': { issue: 67, strategy: 'browser', equivalent: 'Public current build and reload status; privileged deployment details require admin authority.', authority: 'public' },
  'updater.subscribe': { issue: 67, strategy: 'browser', equivalent: 'Public build polling with teardown on navigation; never global operational event streams.', authority: 'public' },
  'updater.subscribeOpenDialog': { issue: 67, strategy: 'browser', equivalent: 'Shared Web update dialog state; actor generation owns subscriptions and dismissal.', authority: 'actor' },
} as const satisfies Record<StudioHostAction, StudioHostParityDecision>;
