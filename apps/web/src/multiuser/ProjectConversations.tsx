import { useState, type FormEvent } from 'react';
import { Button } from '@open-design/components';
import { ArrowLeft } from 'lucide-react';
import type { ConversationsResponse, ConversationResponse, ProjectDetailResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import { useOwnedRequest, useOwnedResource, type OwnedSession } from './owned';
import { isAbort, runErrorKey } from './run-errors';
import styles from './MultiUserApp.module.css';
import runStyles from './Runs.module.css';

export function ProjectConversations(props: OwnedSession & { projectId: string }) {
  const t = useT();
  const request = useOwnedRequest(props);
  const [revision, setRevision] = useState(0);
  const base = `/api/projects/${encodeURIComponent(props.projectId)}`;
  const project = useOwnedResource<ProjectDetailResponse>(request, base, revision);
  const conversations = useOwnedResource<ConversationsResponse>(request, `${base}/conversations`, revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = String(new FormData(form).get('title')).trim();
    if (!title || busy) return;
    setBusy(true); setError(null);
    try {
      const { conversation } = await request<ConversationResponse>(`${base}/conversations`, { method: 'POST', body: JSON.stringify({ title }) });
      if (!request.active()) return;
      window.location.assign(`/projects/${encodeURIComponent(props.projectId)}/conversations/${encodeURIComponent(conversation.id)}`);
    } catch (e) { if (!isAbort(e)) setError(e); }
    finally { setBusy(false); }
  }
  const loadError = project.error || conversations.error;
  return <><a className={runStyles.back} href="/projects"><ArrowLeft size={16} aria-hidden="true" />{t('multiuser.projects')}</a>
    {loadError ? <><p role="alert" className={styles.error}>{t(runErrorKey(loadError))}</p><Button onClick={() => setRevision((n) => n + 1)}>{t('multiuser.retry')}</Button></>
      : !project.data || !conversations.data ? <p role="status">{t('multiuser.loading')}</p> : <>
        <h1>{project.data.project.name}</h1><h2>{t('multiuserRuns.conversations')}</h2>
        <form className={styles.inlineForm} onSubmit={create}><label>{t('multiuserRuns.conversationTitle')}<input name="title" required maxLength={120} /></label><Button variant="primary" type="submit" disabled={busy}>{t('multiuserRuns.createConversation')}</Button></form>
        {Boolean(error) && <p role="alert" className={styles.error}>{t(runErrorKey(error))}</p>}
        {conversations.data.conversations.length === 0 ? <p className={styles.empty}>{t('multiuserRuns.noConversations')}</p> : <ul className={styles.list}>{conversations.data.conversations.map((conversation) => <li key={conversation.id}><a href={`/projects/${encodeURIComponent(props.projectId)}/conversations/${encodeURIComponent(conversation.id)}`}>{conversation.title || t('multiuserRuns.untitled')}</a></li>)}</ul>}
      </>}
  </>;
}
