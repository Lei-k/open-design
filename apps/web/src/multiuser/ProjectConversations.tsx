import { useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import { ArrowLeft } from 'lucide-react';
import type { ConversationsResponse, CreateMultiUserDesignConversationResponse, MultiUserDesignCatalogResponse, MultiUserDesignSelectionsResponse, ProjectDetailResponse } from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import { useOwnedRequest, useOwnedResource, type OwnedSession } from './owned';
import { isAbort, runErrorKey } from './run-errors';
import styles from './MultiUserApp.module.css';
import runStyles from './Runs.module.css';

export function ProjectConversations(props: OwnedSession & { projectId: string }) {
  const t = useT();
  const { locale } = useI18n();
  const request = useOwnedRequest(props);
  const [revision, setRevision] = useState(0);
  const base = `/api/projects/${encodeURIComponent(props.projectId)}`;
  const project = useOwnedResource<ProjectDetailResponse>(request, base, revision);
  const conversations = useOwnedResource<ConversationsResponse>(request, `${base}/conversations`, revision);
  const catalog = useOwnedResource<MultiUserDesignCatalogResponse>(request, '/api/multiuser/design-catalog', revision);
  const selections = useOwnedResource<MultiUserDesignSelectionsResponse>(request, `/api/multiuser/projects/${encodeURIComponent(props.projectId)}/design-selections`, revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = String(new FormData(form).get('title')).trim();
    const skillId = String(new FormData(form).get('skillId') ?? '');
    const designSystemId = String(new FormData(form).get('designSystemId') ?? '');
    if (!title || !skillId || !designSystemId || busy) return;
    setBusy(true); setError(null);
    try {
      const { conversation } = await request<CreateMultiUserDesignConversationResponse>(`/api/multiuser/projects/${encodeURIComponent(props.projectId)}/conversations`, {
        method: 'POST', body: JSON.stringify({ title, skillId, designSystemId, locale }),
      });
      if (!request.active()) return;
      window.location.assign(`/projects/${encodeURIComponent(props.projectId)}/conversations/${encodeURIComponent(conversation.id)}`);
    } catch (e) { if (!isAbort(e)) setError(e); }
    finally { setBusy(false); }
  }
  const loadError = project.error || conversations.error || catalog.error || selections.error;
  const designConversationIds = new Set(selections.data?.designs.map((design) => design.conversationId) ?? []);
  const designConversations = conversations.data?.conversations.filter((conversation) => designConversationIds.has(conversation.id)) ?? [];
  return <><a className={runStyles.back} href="/projects"><ArrowLeft size={16} aria-hidden="true" />{t('multiuser.projects')}</a>
    {loadError ? <><p role="alert" className={styles.error}>{t(runErrorKey(loadError))}</p><Button onClick={() => setRevision((n) => n + 1)}>{t('multiuser.retry')}</Button></>
      : !project.data || !conversations.data || !catalog.data || !selections.data ? <p role="status">{t('multiuser.loading')}</p> : <>
        <h1>{project.data.project.name}</h1><h2>{t('multiuserRuns.conversations')}</h2>
        <form className={styles.inlineForm} onSubmit={create}>
          <label>{t('multiuserRuns.conversationTitle')}<input name="title" required maxLength={120} /></label>
          <label>{t('settings.skills')}<select name="skillId" required defaultValue=""><option value="" disabled>—</option>{catalog.data.skills.map((skill) => <option key={skill.id} value={skill.id}>{skill.displayName?.[locale] ?? skill.name}</option>)}</select></label>
          <label>{t('settings.designSystems')}<select name="designSystemId" required defaultValue=""><option value="" disabled>—</option>{catalog.data.designSystems.map((system) => <option key={system.id} value={system.id}>{system.title}</option>)}</select></label>
          <Button variant="primary" type="submit" disabled={busy || catalog.data.skills.length === 0 || catalog.data.designSystems.length === 0}>{t('multiuserRuns.createConversation')}</Button>
        </form>
        {Boolean(error) && <p role="alert" className={styles.error}>{t(runErrorKey(error))}</p>}
        {designConversations.length === 0 ? <p className={styles.empty}>{t('multiuserRuns.noConversations')}</p> : <ul className={styles.list}>{designConversations.map((conversation) => <li key={conversation.id}><a href={`/projects/${encodeURIComponent(props.projectId)}/conversations/${encodeURIComponent(conversation.id)}`}>{conversation.title || t('multiuserRuns.untitled')}</a></li>)}</ul>}
      </>}
  </>;
}
