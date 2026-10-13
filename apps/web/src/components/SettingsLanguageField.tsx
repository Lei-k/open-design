import { LOCALES, LOCALE_LABEL, useI18n, type Locale } from '../i18n';
import { useAnalytics } from '../analytics/provider';
import { trackSettingsLanguageClick } from '../analytics/events';
import { Icon } from './Icon';

/** Device preference shared by both Settings runtimes; never sent to the
 * account configuration API. */
export function SettingsLanguageField() {
  const { t, locale, setLocale } = useI18n();
  const analytics = useAnalytics();
  return <div className="settings-general-block">
    <div className="settings-general-field">
      <span className="settings-general-label">{t('settings.language')}</span>
      <label className="settings-general-select">
        <select value={locale} aria-label={t('settings.language')} onChange={(event) => {
          const next = event.target.value as Locale;
          trackSettingsLanguageClick(analytics.track, { page_name: 'settings', area: 'language', element: next });
          setLocale(next);
        }}>
          {LOCALES.map((code) => <option key={code} value={code}>{LOCALE_LABEL[code]} · {code}</option>)}
        </select>
        <Icon name="chevron-down" size={14} />
      </label>
    </div>
  </div>;
}
