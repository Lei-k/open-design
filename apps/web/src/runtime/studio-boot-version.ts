/** The deployment version this page booted against (ClientApp's no-store
 * probe). About compares a later probe with it to offer a reload. */
let booted: { version: string; channel: string } | null = null;
export function recordBootVersion(version: { version: string; channel?: unknown }): void {
  booted = { version: version.version, channel: typeof version.channel === 'string' ? version.channel : '' };
}
export function bootVersion(): { version: string; channel: string } | null { return booted; }
