// HTML-preview detail surface for plugins that ship a runnable
// `od.preview` entry or example output (the same surface ExamplesTab
// uses for skill cards). Wraps the shared PreviewModal so the user
// gets the full chrome — sandboxed iframe, Fullscreen, merged Share menu —
// plus a primary
// "Use plugin" action that routes through the home applyPlugin flow.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InstalledPluginRecord,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { useI18n } from '../../i18n';
import { localizePluginChrome } from '../../i18n/plugin-content';
import { localizePluginDescription, localizePluginTitle } from '../plugins-home/localization';
import {
  fetchPluginExampleHtml,
  fetchPluginPreviewHtml,
  fetchStudioPluginPreview,
  type SkillExampleResult,
} from '../../providers/registry';
import { PreviewModal, type PreviewSharePopoverItem } from '../PreviewModal';
import { buildPluginShareUrl } from './PluginShareMenu';
import { PluginMetaSections } from './PluginMetaSections';
import { buildPluginUseMenu, pluginUsePrimaryAction } from './pluginUseMenu';
import type { PluginUseAction } from '../plugins-home/useActions';
import { useStudioCapabilities } from '../../runtime/studio-capabilities';

interface Props {
  record: InstalledPluginRecord;
  /** When set, fetch this specific example stem; otherwise hit /preview. */
  exampleStem?: string | null;
  onClose: () => void;
  onUse: (record: InstalledPluginRecord, action: PluginUseAction) => void;
  onDuplicate?: (record: InstalledPluginRecord) => void;
  isApplying?: boolean;
  hideUseAction?: boolean;
  workspaceContext?: WorkspaceCollabContext | null;
  // Analytics — forwarded to PreviewModal's share popover.
  onSharePopoverItemClick?: (item: PreviewSharePopoverItem) => void;
}

export function PluginExampleDetail(props: Props) {
  const studio = useStudioCapabilities();
  return <PluginExampleDetailBody key={`${props.record.id}:${props.exampleStem ?? ''}:${props.workspaceContext?.workspaceId ?? ''}:${props.workspaceContext?.workspaceMemberId ?? ''}:${studio.actor?.id ?? ''}:${studio.generation}`} {...props} />;
}

function PluginExampleDetailBody({
  record,
  exampleStem,
  onClose,
  onUse,
  onDuplicate,
  isApplying,
  hideUseAction,
  workspaceContext = null,
  onSharePopoverItemClick,
}: Props) {
  const { t, locale } = useI18n();
  const studio = useStudioCapabilities();
  const localizedTitle = localizePluginTitle(locale, record);
  const pluginInfoLabel = localizePluginChrome(locale, 'pluginInfo');
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [unavailableKind, setUnavailableKind] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const requestRef = useRef(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const request = ++requestRef.current;
    try {
      setHtml(null);
      setError(null);
      setUnavailableKind(null);
      setPreviewUrl(null);
      if (!studio.hostServices) {
        const result = await fetchStudioPluginPreview(record.id, exampleStem);
        if (request !== requestRef.current) return;
        if (result) setPreviewUrl(result.url);
        else { setUnavailableKind('html'); setHtml(undefined); }
        return;
      }
      const result: SkillExampleResult = exampleStem
        ? await fetchPluginExampleHtml(record.id, exampleStem, workspaceContext)
        : await fetchPluginPreviewHtml(record.id, workspaceContext);
      if (request !== requestRef.current) return;
      if ('html' in result) {
        setHtml(result.html);
      } else if ('error' in result) {
        setError(result.error);
        setHtml(undefined);
      } else {
        // unavailable: the plugin's manifest declares no shipped
        // preview entry (or the daemon 404s on its /preview path —
        // common for bundled plugins like example-live-artifact whose
        // manifest references an example file that doesn't ship).
        // Forward to PreviewModal as a typed unavailable view so it
        // renders the calm "no shipped preview" placeholder instead
        // of the misleading "Couldn't load this example." error. The
        // skill helper has had this treatment since #897; the plugin
        // helper gained it later — keep both consumers in lockstep.
        setUnavailableKind(result.kind);
        setHtml(undefined);
      }
    } catch (error) {
      if (request === requestRef.current) { setError(error instanceof Error ? error.message : 'HTTP error'); setHtml(undefined); }
    } finally {
      if (request === requestRef.current) inFlightRef.current = false;
    }
  }, [record.id, exampleStem, workspaceContext, studio.hostServices]);

  useEffect(() => {
    void load();
    return () => { requestRef.current++; inFlightRef.current = false; };
  }, [load]);

  // Stable identity for PreviewModal's onView so its mount-time
  // effect doesn't re-fire on every render.
  const onView = useCallback(() => {
    void load();
  }, [load]);

  const description = localizePluginDescription(locale, record);
  const isDeck = record.manifest?.od?.mode === 'deck';

  return (
    <PreviewModal
      title={localizedTitle}
      subtitle={description || undefined}
      views={[
        {
          id: 'preview',
          label: t('examples.previewLabel'),
          html,
          ...(previewUrl ? { custom: <iframe title={`${localizedTitle} ${t('examples.previewLabel')}`} src={previewUrl}
            sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', border: 0 }} /> } : {}),
          error,
          // Pass the surface-appropriate noun so the unavailable placeholder
          // reads "this plugin" / "this template" instead of falling back to
          // the legacy skills-only "this skill" copy. Issue #3216.
          unavailable: unavailableKind
            ? { kind: unavailableKind, noun: isDeck ? 'template' : 'plugin' }
            : null,
          deck: isDeck,
        },
      ]}
      onView={onView}
      exportTitleFor={() => localizedTitle}
      shareTarget={{
        title: localizedTitle,
        description: description || undefined,
        url: buildPluginShareUrl(record),
      }}
      onClose={onClose}
      sidebar={{
        // Surface every plugin-common manifest field — workflow, context
        // bundles, connectors, file paths, source provenance — alongside
        // the rendered HTML preview. Designers are the primary audience
        // here, so the sidebar starts COLLAPSED — the preview is the
        // hero and gets the full stage by default — and when opened it
        // shows a designer-first slice (author + example query) with the
        // developer manifest detail tucked behind a "Developer details"
        // disclosure (variant="minimal"). Fullscreen still gives an
        // immersive view when needed.
        label: pluginInfoLabel,
        defaultOpen: false,
        contentKey: record.id,
        content: (
          <div className="plugin-info-pane">
            <PluginMetaSections
              record={record}
              omit={{ description: true }}
              compact
              heading={pluginInfoLabel}
              variant="minimal"
            />
          </div>
        ),
      }}
      primaryAction={hideUseAction
        ? undefined
        : {
            label: pluginUsePrimaryAction(record, t).label,
            onClick: () => onUse(record, pluginUsePrimaryAction(record, t).action),
            busy: !!isApplying,
            busyLabel: localizePluginChrome(locale, 'applying'),
            testId: `plugin-details-use-${record.id}`,
            menu: buildPluginUseMenu(record, onUse, t, onDuplicate),
          }}
      onSharePopoverItemClick={onSharePopoverItemClick}
    />
  );
}
