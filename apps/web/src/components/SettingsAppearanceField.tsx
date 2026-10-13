import type { Dispatch, SetStateAction } from 'react';
import { useT } from '../i18n';
import type { AppConfig } from '../types';
import { resolveAccentColor } from '../state/appearance';

export function SettingsAppearanceField({ cfg, setCfg }: {
  cfg: AppConfig; setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const t = useT();
  return <div className="settings-general-block">
    <div className="settings-general-field">
      <label className="settings-general-label" htmlFor="settings-accent-color">{t('qf.colorHexLabel')}</label>
      <input id="settings-accent-color" data-testid="settings-accent-color" type="color"
        style={{ width: 48, height: 32, padding: 3 }}
        aria-label={t('qf.colorPickerLabel')} value={resolveAccentColor(cfg.accentColor)}
        onChange={(event) => setCfg((current) => ({ ...current, accentColor: event.target.value }))} />
    </div>
    <p className="hint">{t('qf.colorPreview')}</p>
  </div>;
}
