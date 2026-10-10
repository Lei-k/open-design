import { useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icon';

/**
 * The Settings surface shared by the local dialog and the account-scoped Studio
 * settings: dialog/page chrome, header, collapsible section sidebar and the
 * scrolling content column. It owns presentation only; each host decides which
 * sections exist and what they persist.
 */
export function SettingsFrame({ presentation, header, nav, children, onClose, statusLayer, contentRef, overlay }: {
  presentation: 'modal' | 'page';
  /** Content of the `.modal-head` header. */
  header: ReactNode;
  /** Section items, normally `SettingsNavItem`s. */
  nav: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** Viewport-level status (for example autosave feedback). */
  statusLayer?: ReactNode;
  contentRef?: Ref<HTMLDivElement>;
  /** Dialogs layered above the surface. */
  overlay?: ReactNode;
}) {
  const t = useT();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [fullscreen, setFullscreen] = useState(true);
  const pageMode = presentation === 'page';
  const sidebarToggleLabel = sidebarCollapsed ? 'Expand settings sidebar' : 'Collapse settings sidebar';
  const fullscreenLabel = fullscreen ? t('common.exitFullscreen') : t('common.fullscreen');
  const surface = (
    <div
      className={
        'modal modal-settings' +
        (pageMode ? ' settings-page-surface' : '') +
        (sidebarCollapsed ? ' settings-sidebar-collapsed' : '') +
        (!pageMode && fullscreen ? ' settings-fullscreen' : '')
      }
      role={pageMode ? 'region' : 'dialog'}
      aria-modal={pageMode ? undefined : true}
      aria-labelledby="settings-dialog-title"
      onClick={pageMode ? undefined : (e) => e.stopPropagation()}
    >
      {statusLayer}
      {/* Top-right chrome strip — anchored to the modal corner so the
          close and fullscreen controls stay at a stable optical location
          regardless of the header copy. */}
      <div className="settings-chrome" aria-hidden={false}>
        {pageMode ? null : (
          <button
            type="button"
            className="settings-chrome-btn settings-fullscreen-toggle"
            onClick={() => setFullscreen((current) => !current)}
            aria-label={fullscreenLabel}
            aria-pressed={fullscreen}
            title={fullscreenLabel}
          >
            <Icon name={fullscreen ? 'minimize' : 'maximize'} size={15} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          className="settings-chrome-btn settings-close"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
        >
          <Icon name="close" size={16} strokeWidth={2} />
        </button>
      </div>
      <header className="modal-head" id="settings-dialog-title">{header}</header>
      <div className="modal-body">
        <button
          type="button"
          className="settings-sidebar-toggle"
          onClick={() => setSidebarCollapsed((current) => !current)}
          aria-label={sidebarToggleLabel}
          aria-pressed={sidebarCollapsed}
          aria-controls="settings-sidebar"
          title={sidebarToggleLabel}
        >
          <Icon name={sidebarCollapsed ? 'chevron-right' : 'chevron-left'} size={15} strokeWidth={2} />
        </button>
        <aside
          id="settings-sidebar"
          className="settings-sidebar"
          aria-label="Settings sections"
          aria-hidden={sidebarCollapsed ? true : undefined}
        >
          {pageMode ? (
            <div className="settings-page-nav-head">
              <button type="button" className="settings-page-back" onClick={onClose}>
                <Icon name="arrow-left" size={15} />
                <span>{t('settings.pageBackToHome')}</span>
              </button>
            </div>
          ) : null}
          {nav}
        </aside>
        <div className="settings-content" ref={contentRef}>{children}</div>
      </div>
    </div>
  );
  if (pageMode) return <div className="settings-page-shell">{surface}{overlay}</div>;
  return <div className="modal-backdrop" onClick={onClose}>{surface}{overlay}</div>;
}

export function SettingsNavItem({ active, onClick, icon, title, hint, testId }: {
  active: boolean; onClick: () => void; icon: IconName; title: ReactNode; hint: ReactNode; testId?: string;
}) {
  return (
    <button
      type="button"
      className={`settings-nav-item${active ? ' active' : ''}`}
      onClick={onClick}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <Icon name={icon} size={18} />
      <span>
        <strong>{title}</strong>
        <small>{hint}</small>
      </span>
    </button>
  );
}

/** The standard section header: kicker plus the active section's title. */
export function SettingsSectionHeader({ title, subtitle }: { title: ReactNode; subtitle: ReactNode }) {
  const t = useT();
  return (
    <>
      <span className="kicker">{t('settings.kicker')}</span>
      <div className="modal-head-line">
        <h2>{title}</h2>
        <p className="subtitle">{subtitle}</p>
      </div>
    </>
  );
}
