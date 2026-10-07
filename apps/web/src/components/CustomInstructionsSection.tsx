import { useT } from '../i18n';

/** The same instructions editor is used by local and account Settings. */
export function CustomInstructionsSection({ value, onChange }: { value: string; onChange(value: string): void }) {
  const t = useT();
  return <section className="settings-section settings-section-card instructions-rules-section">
    <div className="memory-field-block instructions-rules-card">
      <div className="memory-block-head"><div>
        <h4>{t('settings.customInstructionsTitle')}</h4>
        <p className="hint">{t('settings.customInstructionsDesc')}</p>
      </div></div>
      <textarea className="custom-instructions-input memory-global-rules-input instructions-rules-input"
        aria-label={t('settings.customInstructionsTitle')} rows={5} maxLength={5000}
        placeholder={t('settings.customInstructionsPlaceholder')} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  </section>;
}
