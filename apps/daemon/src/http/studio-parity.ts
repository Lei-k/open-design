import { STUDIO_PARITY_LANES, type StudioParityLaneId, type StudioRouteParity, type StudioRuntimeCapabilities, type StudioAvailability } from '@open-design/contracts';
import { createHash } from 'node:crypto';
import { MULTIUSER_ROUTE_CLASSIFICATION, type MultiUserRouteClassification } from './multiuser-route-classes.js';

// Responsibility routing, not authorization. New domains fail the inventory
// check until their owner is declared; known domains retain their lane.
const DOMAINS: Readonly<Record<string, StudioParityLaneId>> = {
  health: 'shell', ready: 'shell', version: 'shell', auth: 'shell',
  'agent-accounts': 'settings', admin: 'admin', agents: 'settings',
  'design-systems': 'catalogs', skills: 'catalogs', 'design-templates': 'catalogs',
  'prompt-templates': 'catalogs', templates: 'catalogs', craft: 'catalogs', atoms: 'catalogs',
  plugins: 'catalogs', 'plugin-previews': 'catalogs', 'applied-plugins': 'catalogs',
  'asset-cache': 'catalogs', marketplaces: 'catalogs', community: 'catalogs',
  connectors: 'settings', mcp: 'settings', xai: 'settings', integrations: 'settings',
  amr: 'settings', provider: 'settings', proxy: 'settings', test: 'settings',
  memory: 'settings', library: 'settings', 'app-config': 'settings',
  media: 'generation', 'live-artifacts': 'generation', research: 'generation', critique: 'generation',
  routines: 'automations', orbit: 'automations', 'automation-source-packets': 'automations',
  'automation-ingestions': 'automations', 'automation-proposals': 'automations', 'automation-templates': 'automations',
  workspace: 'collaboration', workspaces: 'collaboration',
  deploy: 'delivery', 'social-share': 'delivery', finalize: 'delivery', handoff: 'delivery',
  dialog: 'web-host', 'dir-exists': 'web-host', 'recent-dirs': 'web-host', editors: 'web-host',
  system: 'web-host', 'project-locations': 'web-host', import: 'home', 'codex-pets': 'web-host',
  daemon: 'web-host', diagnostics: 'web-host', metrics: 'web-host', github: 'web-host', 'whats-new': 'web-host',
  'preview': 'preview', upload: 'composer', artifacts: 'preview',
  strategies: 'execution', chat: 'execution', runs: 'execution',
  active: 'projects', analytics: 'shell', attribution: 'shell', observability: 'shell',
  touchpoints: 'web-host', brands: 'catalogs',
};

export function studioLaneForRoute(entry: Pick<MultiUserRouteClassification, 'method' | 'path' | 'routeClass'>): StudioParityLaneId | null {
  if (entry.routeClass === 'middleware' || entry.routeClass === 'public-web' || entry.path === '/*splat') return 'shell';
  // Regex registration strings are inventory data only. Never turn them into
  // request matchers or use this normalization to relax the authorization gate.
  const path = entry.path.replaceAll('\\', '').replace(/^\/\^/, '').split(',')[0]!;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'artifacts' || parts[0] === 'frames') return 'preview';
  if (parts[0] !== 'api') return null;
  const domain = parts[1];
  if (domain === 'multiuser') {
    if (parts[2] === 'settings') return 'settings';
    if (parts[2] === 'catalog') return 'catalogs';
    if (parts[2] === 'design-catalog') return 'catalogs';
    if (path.includes('/preview')) return 'preview';
    return parts[2] === 'projects' ? 'projects' : null;
  }
  if (domain === 'tools') {
    const tool = parts[2];
    if (tool === 'connectors' || tool === 'library') return 'settings';
    if (tool === 'design-systems' || tool === 'deliverable-syntax') return 'catalogs';
    return tool === 'live-artifacts' || tool === 'media' ? 'generation' : null;
  }
  if (domain === 'projects') {
    if (parts.length <= 3) return 'projects';
    if (/\/(?:presence|collab|workspace-scope)(?:\/|$)/.test(path) || path.includes('/comments')) return 'collaboration';
    if (/\/(?:media|genui|critique)(?:\/|$)/.test(path)) return 'generation';
    if (/\/(?:plugins|plugin-candidates|applied-plugins|scenario|design-system-copy)(?:\/|$)/.test(path)) return 'catalogs';
    if (/\/(?:open-in|working-dir|terminals|browser-sessions)(?:\/|$)/.test(path)) return 'web-host';
    if (path.includes('/figma')) return 'home';
    if (/\/(?:export|archive|deploy|deployments|finalize|handoff)(?:\/|$)/.test(path) || path.includes('/publish-public')) return 'delivery';
    if (/\/(?:preview|preview-url|powered|text-preview|chat-artifact-snapshots|workspace-artifacts)(?:\/|$)/.test(path) || path.endsWith('/artifacts')) return 'preview';
    if (/\/(?:files|file-content|raw|folders|search|upload|design-token-suggestions|design-system-package-audit)(?:\/|$)/.test(path)) return 'files';
    if (/\/(?:conversations|tabs|events|duplicate)(?:\/|$)/.test(path)) return 'projects';
    return null;
  }
  if (domain === 'runs' && /\/(?:genui|devloop-iterations)(?:\/|$)/.test(path)) return 'generation';
  return domain ? DOMAINS[domain] ?? null : null;
}

export function studioRouteParityInventory(): StudioRouteParity[] {
  return MULTIUSER_ROUTE_CLASSIFICATION.map((entry) => {
    const lane = studioLaneForRoute(entry);
    if (!lane) throw new Error(`Studio parity route has no owner: ${entry.key}`);
    const descriptor = STUDIO_PARITY_LANES.find((item) => item.id === lane)!;
    const path = entry.path.replaceAll('\\', '').replace(/^\/\^/, '').split(',')[0]!;
    return { key: entry.key, lane, issue: descriptor.issue, routeClass: entry.routeClass, reason: entry.reason,
      singleUserApi: entry.method !== 'USE' && path.startsWith('/api/') && !/^\/api\/(?:multiuser|auth|admin|agent-accounts)(?:\/|$)/.test(path)
        ? entry.key : null,
      owner: descriptor.owner, component: descriptor.component, targetData: descriptor.data,
      credentialOwner: descriptor.credentials, webStrategy: descriptor.web };
  });
}

/**
 * Lanes a pilot actor may use before their deployment-wide gate closes, with
 * the acceptance still outstanding. `pilot` never reaches public discovery.
 */
export const STUDIO_PILOT_LANES: Partial<Record<StudioParityLaneId, string>> = {
  shell: 'Pilot shell: deployment rollout, legacy shell removal and the remaining provider closures are pending (#53, #70).',
  projects: 'Pilot projects: artifact, upload and background-job lineage are pending (#54).',
  execution: 'Pilot execution: personal Codex and the OpenAI company pool; real-provider acceptance, feedback telemetry and replay are pending (#55).',
  chat: 'Pilot chat: real-provider recordings and the full state-matrix acceptance are pending (#56).',
  composer: 'Pilot composer: text, attachments, private text skills, queue, stop and question answers; bundled skill attachments, design systems and model choice are pending (#57).',
  preview: 'Pilot preview: opaque HTML/deck/media previews, manual edit, inspect and owner-only immutable artifact snapshots/thumbnails; comments, renderer covers and complete browser acceptance are pending (#59).',
  files: 'Pilot files: owner file list, read, write, upload, rename, delete, folders, search and versions; archive, public publish and resumable large uploads are pending (#58).',
  home: 'Pilot Home: shared Prototype, Deck and Other setup with account skills and design systems; live artifacts, media, saved templates, duplicate and browser imports are pending (#60).',
  settings: 'Pilot settings: account instructions, manual memory and profile injection; automatic extraction, verification, connectors, MCP and library are pending (#62).',
  catalogs: 'Pilot catalogs: bundled templates and craft, account-owned text skills and versioned design documents; generation, skill attachments, plugins and team catalogs are pending (#61).',
};

/** Advertise a lane only after its entire acceptance closes. The public
 * version call uses the default legacy shell; only a cookie-authorized session
 * read may opt its actor into the pilot. Pilot selection does not complete
 * lanes: it marks the pilot-usable ones `pilot`, never `supported`, and a lane
 * whose server policy is off is `admin-disabled` for the pilot as well.
 */
export function multiUserStudioCapabilities(studioPilot = false, policy: { personalEnabled?: boolean; companyEnabled?: boolean } = {}): StudioRuntimeCapabilities {
  const unavailable = (issue: number): StudioAvailability => ({
    status: 'unavailable', reason: `Studio integration #${issue} has not passed its complete parity gate; the legacy fallback remains active.`,
  });
  const executionOff: StudioAvailability = { status: 'admin-disabled',
    reason: 'No execution source is enabled on this server.' };
  const features = Object.fromEntries(STUDIO_PARITY_LANES.map((lane): [StudioParityLaneId, StudioAvailability] => {
    if (lane.id === 'baseline') return [lane.id, { status: 'supported' }];
    const pilot = studioPilot ? STUDIO_PILOT_LANES[lane.id] : undefined;
    if (!pilot) return [lane.id, unavailable(lane.issue)];
    if ((lane.id === 'execution' || lane.id === 'composer') && !policy.personalEnabled && !policy.companyEnabled) return [lane.id, executionOff];
    return [lane.id, { status: 'pilot', reason: pilot }];
  })) as StudioRuntimeCapabilities['features'];
  return { schemaVersion: 1, shell: studioPilot ? 'studio' : 'legacy-multiuser', features,
    ...(studioPilot ? { executionSources: [
      ...(policy.personalEnabled ? [{ source: 'personal_subscription' as const, agentId: 'codex' as const }] : []),
      ...(policy.companyEnabled ? [{ source: 'company_pool' as const, agentId: 'openai' as const }] : []),
    ] } : {}) };
}

/** The actor's private transcript-id namespace (see `isStudioMessageIdInNamespace`).
 * Derived, not stored: only the server-side actor selects it, and the digest
 * does not reveal the account id inside message ids. */
export function studioMessageIdPrefix(accountId: string): string {
  return `mua_${createHash('sha256').update(`studio-message-namespace:${accountId}`).digest('hex').slice(0, 24)}_`;
}
