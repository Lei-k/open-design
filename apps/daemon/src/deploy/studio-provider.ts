import { randomUUID } from 'node:crypto';
import type { StudioDeployConfig, StudioDeployProvider, StudioDeployment } from '@open-design/contracts';
import {
  vercelDeploymentRequestBody,
  cloudflarePagesAssetHash,
  chunkCloudflarePagesAssetUploads,
  type DeployFile,
} from '../deploy.js';
import {
  createSafeOutboundFetch,
  OutboundRequestRefused,
  type SafeOutboundOptions,
} from '../http/safe-outbound-fetch.js';
import { carriesSecret, knownSecrets, type KnownSecrets } from '../mcp-client/studio-untrusted.js';

/** Direct startServer test injection only; never derived from env or deployment configuration. */
export interface StudioDeployOutboundInjection extends Pick<
  SafeOutboundOptions,
  'resolve' | 'allowAddress' | 'timeoutMs'
> {
  apiOrigin?: string;
}
export class StudioDeployProviderError extends Error {
  constructor() {
    super('The deployment provider did not complete the request.');
  }
}
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => (v && typeof v === 'object' && !Array.isArray(v) ? (v as ObjectValue) : {});
/** Provider metadata is hostile: keep only shape-checked nonsecret identifiers, URLs and states. */
export function deploymentProjection(
  value: unknown,
  provider: StudioDeployProvider,
  secrets: KnownSecrets,
): Pick<StudioDeployment, 'deploymentId' | 'url' | 'status'> {
  const row = object(value);
  const id = row.id ?? row.uid;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || carriesSecret(id, secrets))
    throw new StudioDeployProviderError();
  let url = '';
  if (typeof row.url === 'string' && row.url.length <= 512 && !carriesSecret(row.url, secrets)) {
    try {
      const u = new URL(row.url.startsWith('https://') ? row.url : `https://${row.url}`);
      const suffix = provider === 'vercel' ? '.vercel.app' : '.pages.dev';
      if (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        u.port === '' &&
        u.hostname.endsWith(suffix) &&
        u.pathname === '/' &&
        !u.search &&
        !u.hash
      )
        url = u.origin;
    } catch {
      /* untrusted URL dropped */
    }
  }
  const state = row.readyState ?? object(row.latest_stage).status;
  return {
    deploymentId: id,
    url,
    status:
      state === 'READY' || state === 'success'
        ? 'ready'
        : state === 'ERROR' || state === 'failure'
          ? 'failed'
          : 'building',
  };
}

/** All API/upload calls use fixed provider API hosts; redirects are refused, including same-host redirects. */
export function studioProvider(input: {
  provider: StudioDeployProvider;
  config: StudioDeployConfig;
  authorize: () => string;
  outbound?: StudioDeployOutboundInjection;
}) {
  const safe = createSafeOutboundFetch({
    ...input.outbound,
    maxRedirects: 0,
    maxResponseBytes: 1024 * 1024,
    timeoutMs: input.outbound?.timeoutMs ?? 10_000,
  });
  const sentCredentials = new Set<string>();
  let secrets = knownSecrets([]);
  let uploadToken: string | null = null;
  const start = Date.now();
  const api = input.provider === 'vercel' ? 'https://api.vercel.com' : 'https://api.cloudflare.com/client/v4';
  const request = async (
    suffix: string,
    method = 'GET',
    body?: string,
    asset = false,
    contentType = 'application/json',
    allow404 = false,
  ) => {
    if (Date.now() - start > 120_000) throw new OutboundRequestRefused('timeout');
    const canonical = new URL(`${api}${suffix}`);
    if (!['api.vercel.com', 'api.cloudflare.com'].includes(canonical.hostname))
      throw new OutboundRequestRefused('host');
    const url = input.outbound?.apiOrigin
      ? `${input.outbound.apiOrigin}${canonical.pathname}${canonical.search}`
      : canonical.toString();
    const expected = new URL(url).origin;
    const response = await safe(url, {
      method,
      ...(body !== undefined ? { body } : {}),
      headers: { 'Content-Type': contentType },
      timeoutMs: Math.max(1, 120_000 - (Date.now() - start)),
      beforeConnect: (hop) => {
        if (hop.url.origin !== expected || hop.hop !== 0) throw new OutboundRequestRefused('host');
        // Account token is decrypted only after the synchronous live authority check, at dispatch and socket.
        const token = input.authorize();
        sentCredentials.add(token);
        sentCredentials.add(`Bearer ${token}`);
        secrets = knownSecrets(sentCredentials);
        if (hop.phase === 'dispatch') return { headers: { Authorization: `Bearer ${asset ? uploadToken : token}` } };
      },
    });
    if (allow404 && response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw new StudioDeployProviderError();
    let json: ObjectValue;
    try {
      json = object(response.json());
    } catch {
      throw new StudioDeployProviderError();
    }
    if (json.success === false) throw new StudioDeployProviderError();
    return json;
  };
  const team = new URLSearchParams();
  if (input.config.teamId) team.set('teamId', input.config.teamId);
  else if (input.config.teamSlug) team.set('slug', input.config.teamSlug);
  const query = team.size ? `?${team}` : '';
  const cfBase = `/accounts/${encodeURIComponent(input.config.accountId ?? '')}/pages/projects`;
  const cfProject = `${cfBase}/${encodeURIComponent(input.config.projectName ?? '')}`;
  const projection = (row: unknown) => deploymentProjection(row, input.provider, secrets);
  return {
    async deploy(files: DeployFile[], projectId: string, target: 'preview' | 'production') {
      if (input.provider === 'vercel') {
        const json = await request(
          `/v13/deployments${query}`,
          'POST',
          JSON.stringify({
            ...vercelDeploymentRequestBody(files, projectId),
            ...(target === 'production' ? { target: 'production' } : {}),
          }),
        );
        return projection(json);
      }
      if (!input.config.accountId || !input.config.projectName) throw new StudioDeployProviderError();
      if (!(await request(cfProject, 'GET', undefined, false, 'application/json', true)))
        await request(cfBase, 'POST', JSON.stringify({ name: input.config.projectName, production_branch: 'main' }));
      const issued = await request(`${cfProject}/upload-token`);
      const jwt = object(issued?.result).jwt;
      if (typeof jwt !== 'string' || jwt.length < 16 || jwt.length > 8192 || /[^\x21-\x7e]/.test(jwt))
        throw new StudioDeployProviderError();
      uploadToken = jwt;
      sentCredentials.add(jwt);
      sentCredentials.add(`Bearer ${jwt}`);
      secrets = knownSecrets(sentCredentials);
      const unique = new Map(
        files.map((f) => [
          cloudflarePagesAssetHash(f),
          {
            hash: cloudflarePagesAssetHash(f),
            data: Buffer.from(f.data),
            ...(f.contentType ? { contentType: f.contentType } : {}),
          },
        ]),
      );
      const hashes = [...unique.keys()];
      const checked = await request('/pages/assets/check-missing', 'POST', JSON.stringify({ hashes }), true);
      const result = checked?.result;
      const missing = Array.isArray(result) ? result : object(result).hashes;
      if (
        !Array.isArray(missing) ||
        missing.length > hashes.length ||
        missing.some((h) => typeof h !== 'string' || !unique.has(h))
      )
        throw new StudioDeployProviderError();
      for (const batch of chunkCloudflarePagesAssetUploads(
        missing.map((h) => unique.get(h as string)!),
        { maxFiles: 100, maxBytes: 16 * 1024 * 1024 },
      ))
        await request(
          '/pages/assets/upload',
          'POST',
          JSON.stringify(
            batch.map((f) => ({
              key: f.hash,
              value: f.data.toString('base64'),
              metadata: { ...(f.contentType ? { contentType: f.contentType } : {}) },
              base64: true,
            })),
          ),
          true,
        );
      await request('/pages/assets/upsert-hashes', 'POST', JSON.stringify({ hashes }), true);
      const manifest = Object.fromEntries(files.map((f) => [`/${f.file}`, cloudflarePagesAssetHash(f)]));
      const boundary = `od-${randomUUID()}`;
      const body =
        [
          ['manifest', JSON.stringify(manifest)],
          ['branch', target === 'preview' ? 'preview' : 'main'],
        ]
          .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
          .join('') + `--${boundary}--\r\n`;
      const deployed = await request(
        `${cfProject}/deployments`,
        'POST',
        body,
        false,
        `multipart/form-data; boundary=${boundary}`,
      );
      return projection(deployed?.result);
    },
    async status(id: string) {
      const row = await request(
        input.provider === 'vercel'
          ? `/v13/deployments/${encodeURIComponent(id)}${query}`
          : `${cfProject}/deployments/${encodeURIComponent(id)}`,
      );
      const projected = projection(input.provider === 'vercel' ? row : row?.result);
      if (projected.deploymentId !== id) throw new StudioDeployProviderError();
      return projected;
    },
    async checkLink(url: string) {
      const checked = deploymentProjection({ id: 'link', url }, input.provider, secrets);
      if (!checked.url) throw new OutboundRequestRefused('host');
      const destination = input.outbound?.apiOrigin ? `${input.outbound.apiOrigin}/link` : checked.url;
      const expected = new URL(destination).origin;
      const response = await safe(destination, {
        method: 'HEAD',
        beforeConnect: (hop) => {
          if (hop.url.origin !== expected || hop.hop) throw new OutboundRequestRefused('host');
          input.authorize();
        },
      });
      return {
        reachable: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        checkedAt: Date.now(),
      };
    },
  };
}
