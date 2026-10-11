import { StudioCapabilityMessage, useStudioCapabilityState } from './StudioCapabilityState';
import { StudioExternalLink } from './StudioExternalLink';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type { StudioDeployConfig, StudioDeployProvider, StudioDeployment } from '@open-design/contracts';
import { useT } from '../i18n';
import { studioFetch } from './studio-transport';
import styles from './StudioDeploy.module.css';

export function StudioDeploySettings() {
  const t = useT();
  const [configs, setConfigs] = useState<StudioDeployConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async () => {
    try {
      setConfigs(
        await Promise.all(
          (['vercel', 'cloudflare-pages'] as const).map(async (provider) => {
            const response = await studioFetch(`/api/deploy/config?providerId=${provider}`);
            if (!response.ok) throw new Error();
            return response.json() as Promise<StudioDeployConfig>;
          }),
        ),
      );
    } catch {
      setError(t('studio.deployFailed'));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async (event: React.FormEvent<HTMLFormElement>, config: StudioDeployConfig) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const token = String(fields.get('token') ?? '');
    form.reset();
    setBusy(true);
    setError('');
    try {
      const response = await studioFetch('/api/deploy/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providerId: config.providerId,
          revision: config.revision,
          token,
          ...(config.providerId === 'cloudflare-pages'
            ? { accountId: fields.get('accountId'), projectName: fields.get('projectName') }
            : { teamId: fields.get('teamId'), teamSlug: fields.get('teamSlug') }),
        }),
      });
      if (!response.ok) throw new Error();
      await load();
    } catch {
      setError(t('studio.deployFailed'));
    } finally {
      setBusy(false);
    }
  };
  const clear = async (config: StudioDeployConfig) => {
    setBusy(true);
    try {
      const res = await studioFetch('/api/deploy/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: config.providerId, revision: config.revision, token: null }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError(t('studio.deployFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.panel} data-testid="studio-deploy-settings">
      <p>{t('studio.deployHint')}</p>
      {configs.map((config) => (
        <form key={config.providerId} onSubmit={(event) => void save(event, config)} className={styles.panel}>
          <h3>{config.providerId === 'vercel' ? 'Vercel' : 'Cloudflare Pages'}</h3>
          <p role="status">
            {config.configured ? `${t('studio.deployConfigured')} · ••••${config.last4}` : t('studio.deployMissing')}
          </p>
          <label>
            {t('studio.deployToken')}
            <input name="token" type="password" autoComplete="new-password" required minLength={16} maxLength={4096} />
          </label>
          {config.providerId === 'cloudflare-pages' ? (
            <>
              <label>
                Account ID
                <input name="accountId" defaultValue={config.accountId ?? ''} required maxLength={128} />
              </label>
              <label>
                Project name
                <input name="projectName" defaultValue={config.projectName ?? ''} maxLength={128} />
              </label>
            </>
          ) : (
            <>
              <label>
                Team ID
                <input name="teamId" defaultValue={config.teamId ?? ''} maxLength={128} />
              </label>
              <label>
                Team slug
                <input name="teamSlug" defaultValue={config.teamSlug ?? ''} maxLength={128} />
              </label>
            </>
          )}
          <Button type="submit" disabled={busy}>
            {t('common.save')}
          </Button>
          <Button type="button" disabled={busy || !config.configured} onClick={() => void clear(config)}>
            {t('studio.deployClear')}
          </Button>
        </form>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** Owner-only Share menu entry plus immutable deployment history. No token is accepted in the viewer. */
export function StudioDeployMenu({
  projectId,
  fileName,
  owner,
}: {
  projectId: string;
  fileName: string;
  owner: boolean;
}) {
  const t = useT();
  const [configs, setConfigs] = useState<StudioDeployConfig[]>([]);
  const [records, setRecords] = useState<StudioDeployment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadGeneration = useRef(0);
  const deployState = useStudioCapabilityState('deploy', { permissionGranted: owner });
  const configReasonId = useId();
  const load = async () => {
    if (!owner) return;
    const generation = ++loadGeneration.current;
    try {
      const configs = await Promise.all(
        (['vercel', 'cloudflare-pages'] as const).map(async (p) => {
          const response = await studioFetch(`/api/deploy/config?providerId=${p}`);
          if (!response.ok) throw new Error();
          return response.json() as Promise<StudioDeployConfig>;
        }),
      );
      if (generation !== loadGeneration.current) return;
      setConfigs(configs);
      const res = await studioFetch(`/api/projects/${projectId}/deployments`);
      if (generation !== loadGeneration.current) return;
      if (res.ok) setRecords((await res.json()).deployments);
    } catch {
      setError(t('studio.deployFailed'));
    }
  };
  useEffect(() => {
    setRecords([]);
    setConfigs([]);
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [projectId, fileName, owner]);
  const act = async (path: string, method: string, body?: unknown) => {
    setBusy(true);
    setError('');
    try {
      const res = await studioFetch(path, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(t(data?.error?.code === 'MULTIUSER_DEPLOY_HISTORY_FULL' ? 'studio.deployHistoryFull' : 'studio.deployFailed'));
        return;
      }
      await load();
    } catch {
      setError(t('studio.deployFailed'));
    } finally {
      setBusy(false);
    }
  };
  const deploy = (provider: StudioDeployProvider) =>
    act(`/api/projects/${projectId}/deploy`, 'POST', { fileName, providerId: provider });
  return (
    <section className={styles.panel} data-testid="studio-deploy-menu">
      <strong>{t('studio.deployTitle')}</strong>
      <StudioCapabilityMessage state={deployState} />
      {!owner ? (
        deployState.reasonKey ? null : <p role="status">{t('studio.deployOwnerOnly')}</p>
      ) : (
        <>
          {configs.map((config) => (
            <div key={config.providerId}>
              <Button aria-describedby={!config.configured ? `${configReasonId}-${config.providerId}` : undefined} disabled={busy || !config.configured} onClick={() => void deploy(config.providerId)}>
                {config.providerId === 'vercel' ? 'Vercel' : 'Cloudflare Pages'}
              </Button>
              {!config.configured && <p role="status" id={`${configReasonId}-${config.providerId}`}>{t('studio.deployMissingHint')}</p>}
            </div>
          ))}
          {busy && <p role="status">{t('studio.deployProgress')}</p>}
          {error && <p role="alert">{error}</p>}
          {records
            .filter((r) => r.fileName === fileName)
            .map((row) => (
              <div key={row.id}>
                <span>
                  {row.providerId} · {row.status} · {new Date(row.createdAt).toLocaleString()}
                </span>
                {row.url && (
                  <StudioExternalLink href={row.url}>{row.url}</StudioExternalLink>
                )}
                {(['status', 'check-link', 'redeploy', 'delete'] as const).map((action) => (
                  <Button
                    key={action}
                    aria-describedby={action !== 'delete' && !configs.find((c) => c.providerId === row.providerId)?.configured ? `${configReasonId}-${row.providerId}` : undefined}
                    disabled={
                      busy || (action !== 'delete' && !configs.find((c) => c.providerId === row.providerId)?.configured)
                    }
                    onClick={() =>
                      void act(
                        `/api/projects/${projectId}/deployments/${row.id}${action === 'delete' ? '' : `/${action}`}`,
                        action === 'delete' ? 'DELETE' : 'POST',
                        action === 'delete' ? undefined : {},
                      )
                    }
                  >
                    {t(
                      action === 'status'
                        ? 'studio.deployStatus'
                        : action === 'check-link'
                          ? 'studio.deployCheckLink'
                          : action === 'redeploy'
                            ? 'studio.deployRedeploy'
                            : 'studio.deployDelete',
                    )}
                  </Button>
                ))}
                {row.lastLinkCheck && (
                  <span>
                    {row.lastLinkCheck.statusCode} · {String(row.lastLinkCheck.reachable)}
                  </span>
                )}
              </div>
            ))}
        </>
      )}
    </section>
  );
}
