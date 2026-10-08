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
  system: 'web-host', 'project-locations': 'web-host', import: 'home', 'codex-pets': 'settings',
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
    if (parts[2] === 'import') return 'home';
    if (parts[2] === 'settings') return 'settings';
    if (parts[2] === 'catalog') return parts[3] === 'codex-pets' ? 'settings' : 'catalogs';
    if (parts[2] === 'design-catalog') return 'catalogs';
    if (parts[2] === 'routines' || parts[2]?.startsWith('automation-')) return 'automations';
    if (path.includes('/archive') || path.includes('/export/') || path.includes('/public-links') || parts[2] === 'public') return 'delivery';
    if (/\/(?:shares|access|presence)(?:\/|$)/.test(path)) return 'collaboration';
    if (path.includes('/preview') || path.includes('/comments')) return 'preview';
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
    if (/\/(?:presence|collab|workspace-scope)(?:\/|$)/.test(path)) return 'collaboration';
    // Preview comments are #59 (shared between project members since #65).
    if (path.includes('/comments')) return 'preview';
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
  execution: 'Pilot execution: personal Codex, the OpenAI company pool and each account\'s own encrypted OpenAI API key; real-provider acceptance, feedback telemetry and replay are pending (#55).',
  chat: 'Pilot chat: real-provider recordings and the full state-matrix acceptance are pending (#56).',
  composer: 'Pilot composer: text, attachments, private and bundled skills, design systems, queue, stop, question answers, preview comment attachments and personal Codex model/effort; rich media inputs and plugins are pending (#57).',
  preview: 'Pilot preview: opaque HTML/deck/media previews, manual edit, inspect, comments shared with project members and immutable artifact snapshots/thumbnails; renderer covers and complete browser acceptance are pending (#59).',
  files: 'Pilot files: owner file list, read, write, upload, rename, delete, folders, search and versions; public publish and resumable large uploads are pending (#58).',
  automations: 'Pilot automations: account-owned routines with schedules, manual runs, history and per-dispatch authority on personal Codex or the company pool, bundled templates, source ingestion, reviewable proposals applied into the account\'s own memory, skills and design documents, and crystallizing runs into private skill packages; plugin/MCP/connector context, the account\'s own OpenAI key as a routine source and real-provider scheduled acceptance are pending (#64).',
  delivery: 'Pilot delivery: owned project/folder/batch ZIP downloads and one-file HTML exports (current or historical version) from captured bytes with design handoff, server-rendered PDF/PPTX/PNG where the deployment configured a renderer, and deployment-local public links to captured files on the preview origin; cloud deploy is pending (#66).',
  home: 'Pilot Home: Prototype, Deck, Other, Image/Video/Audio on an OpenAI source, immutable saved templates, project copies and browser ZIP/directory imports; live artifacts, HyperFrames and Figma import are pending (#60).',
  settings: 'Pilot settings: account appearance/notification preferences, in-page pet (bundled catalog), instructions, manual memory and profile injection; full navigation, providers, automatic extraction, verification, connectors, MCP and library are pending (#62).',
  collaboration: 'Pilot collaboration: owner-managed view/comment/edit sharing with other accounts of this deployment, members, presence and shared comments with server-stamped authors; revocation closes open streams and stops turns. Shared design systems/skills/plugins and live chat mirroring are pending (#65).',
  generation: 'Pilot generation: image (gpt-image-1), narration (gpt-4o-mini-tts) and short video (sora-2) inside OpenAI turns, billed to the turn\'s own source (company pool or the account\'s key) and saved in the project; live artifacts, GenUI, research and critique are pending (#63).',
  catalogs: 'Pilot catalogs: bundled templates/craft, account text and folder skills, captured skill packages with company script/binary tools, and versioned design documents; design generation/asset packages, plugins and team catalogs are pending (#61).',
};

/** Advertise a lane only after its entire acceptance closes. The public
 * version call uses the default legacy shell; only a cookie-authorized session
 * read may opt its actor into the pilot. Pilot selection does not complete
 * lanes: it marks the pilot-usable ones `pilot`, never `supported`, and a lane
 * whose server policy is off is `admin-disabled` for the pilot as well.
 */
export function multiUserStudioCapabilities(studioPilot = false, policy: { personalEnabled?: boolean; companyEnabled?: boolean; personalKeysEnabled?: boolean; renderedExports?: boolean } = {}): StudioRuntimeCapabilities {
  const unavailable = (issue: number): StudioAvailability => ({
    status: 'unavailable', reason: `Studio integration #${issue} has not passed its complete parity gate; the legacy fallback remains active.`,
  });
  const executionOff: StudioAvailability = { status: 'admin-disabled',
    reason: 'No execution source is enabled on this server.' };
  const features = Object.fromEntries(STUDIO_PARITY_LANES.map((lane): [StudioParityLaneId, StudioAvailability] => {
    if (lane.id === 'baseline') return [lane.id, { status: 'supported' }];
    const pilot = studioPilot ? STUDIO_PILOT_LANES[lane.id] : undefined;
    if (!pilot) return [lane.id, unavailable(lane.issue)];
    if ((lane.id === 'execution' || lane.id === 'composer') && !policy.personalEnabled && !policy.companyEnabled && !policy.personalKeysEnabled) return [lane.id, executionOff];
    // Media runs on an OpenAI source only; personal Codex has no media functions.
    if (lane.id === 'generation' && !policy.companyEnabled && !policy.personalKeysEnabled) return [lane.id, { status: 'admin-disabled',
      reason: 'Media generation needs the company OpenAI pool or accounts\' own OpenAI keys; neither is enabled on this server.' }];
    return [lane.id, { status: 'pilot', reason: pilot }];
  })) as StudioRuntimeCapabilities['features'];
  return { schemaVersion: 1, shell: studioPilot ? 'studio' : 'legacy-multiuser', features,
    ...(studioPilot ? { executionSources: [
      ...(policy.personalEnabled ? [{ source: 'personal_subscription' as const, agentId: 'codex' as const }] : []),
      ...(policy.companyEnabled ? [{ source: 'company_pool' as const, agentId: 'openai' as const }] : []),
      // Listed last so it is never the default; the account adds its own key in Settings.
      ...(policy.personalKeysEnabled ? [{ source: 'personal_api_key' as const, agentId: 'openai-byok' as const }] : []),
    ], renderedExports: policy.renderedExports === true } : {}) };
}

/** The actor's private transcript-id namespace (see `isStudioMessageIdInNamespace`).
 * Derived, not stored: only the server-side actor selects it, and the digest
 * does not reveal the account id inside message ids. */
export function studioMessageIdPrefix(accountId: string): string {
  return `mua_${createHash('sha256').update(`studio-message-namespace:${accountId}`).digest('hex').slice(0, 24)}_`;
}
