import { useState, type Dispatch, type SetStateAction } from 'react';
import { Button } from '@open-design/components';
import { useI18n } from '../i18n';
import { useAnalytics } from '../analytics/provider';
import { trackSettingsNotificationsClick } from '../analytics/events';
import type { AppConfig } from '../types';
import { DEFAULT_NOTIFICATIONS } from '../state/config';
import { FAILURE_SOUNDS, SUCCESS_SOUNDS, notificationPermission, playSound,
  requestNotificationPermission, showCompletionNotification } from '../utils/notifications';

// Map the runtime SoundId (hyphenated, used by utils/notifications.ts) onto
// the contract's underscored enum. Sounds that don't have a tracking entry
// drop to undefined so we never emit an off-enum value.
function soundIdToTracking(
  id: string,
):
  | 'ding'
  | 'chime'
  | 'two_tone_up'
  | 'pluck'
  | 'buzz'
  | 'two_tone_down'
  | 'thud'
  | undefined {
  switch (id) {
    case 'ding':
      return 'ding';
    case 'chime':
      return 'chime';
    case 'two-tone-up':
      return 'two_tone_up';
    case 'pluck':
      return 'pluck';
    case 'buzz':
      return 'buzz';
    case 'two-tone-down':
      return 'two_tone_down';
    case 'thud':
      return 'thud';
    default:
      return undefined;
  }
}

export function NotificationsSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const notif = cfg.notifications ?? DEFAULT_NOTIFICATIONS;
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    () => notificationPermission(),
  );
  const [testStatus, setTestStatus] = useState<ReturnType<typeof testNotificationStatusText> | null>(null);

  const updateNotif = (
    patch: Partial<NonNullable<AppConfig['notifications']>>,
  ) => {
    setCfg((c) => ({
      ...c,
      notifications: { ...DEFAULT_NOTIFICATIONS, ...(c.notifications ?? {}), ...patch },
    }));
  };

  const toggleSound = () => {
    const next = !notif.soundEnabled;
    // P1 ui_click area=notifications element=completion_sound — the toggle
    // emits the post-click state on `completion_sound_status` so a single
    // event captures intent + outcome.
    trackSettingsNotificationsClick(analytics.track, {
      page_name: 'settings',
      area: 'notifications',
      element: 'completion_sound',
      completion_sound_status: next ? 'on' : 'off',
    });
    updateNotif({ soundEnabled: next });
    // Give the user immediate audible feedback when turning the master
    // switch on so they know which sound they're signing up for. Resuming
    // the AudioContext also bakes in their gesture for later auto-plays.
    if (next) playSound(notif.successSoundId);
  };

  const toggleDesktop = async () => {
    if (notif.desktopEnabled) {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'off',
      });
      updateNotif({ desktopEnabled: false });
      return;
    }
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'on',
      });
      updateNotif({ desktopEnabled: true });
    } else {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'off',
      });
      updateNotif({ desktopEnabled: false });
    }
  };

  const sendTestNotification = async () => {
    const result = await showCompletionNotification({
      status: 'succeeded',
      title: t('notify.successTitle'),
      body: t('notify.successBody'),
    });
    setPermission(notificationPermission());
    setTestStatus(testNotificationStatusText(result));
  };

  return (
    <section className="settings-section">
      <div className="settings-subsection">
        <div className="settings-notify-card">
          <div className="settings-notify-card-header">
            <h4>{t('settings.notifyCompletionSound')}</h4>
            <div className="section-head-actions">
              <div className="seg-control" role="group" aria-label={t('settings.notifyCompletionSound')} style={{ '--seg-cols': 2 } as React.CSSProperties}>
                <button
                  type="button"
                  className={'seg-btn seg-btn--on' + (notif.soundEnabled ? ' active' : '')}
                  aria-pressed={notif.soundEnabled}
                  onClick={() => { if (!notif.soundEnabled) toggleSound(); }}
                >
                  <span className="seg-title">{t('common.active')}</span>
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (!notif.soundEnabled ? ' active' : '')}
                  aria-pressed={!notif.soundEnabled}
                  onClick={() => { if (notif.soundEnabled) toggleSound(); }}
                >
                  <span className="seg-title">{t('common.inactive')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {notif.soundEnabled ? (
          <>
            <div className="settings-field">
              <label>{t('settings.notifySuccessSound')}</label>
              <div className="seg-control" role="group" aria-label={t('settings.notifySuccessSound')} style={{ '--seg-cols': SUCCESS_SOUNDS.length } as React.CSSProperties}>
                {SUCCESS_SOUNDS.map((sound) => (
                  <button
                    key={sound.id}
                    type="button"
                    className={'seg-btn' + (notif.successSoundId === sound.id ? ' active' : '')}
                    aria-pressed={notif.successSoundId === sound.id}
                    onClick={() => {
                      const trackingSoundId = soundIdToTracking(sound.id);
                      trackSettingsNotificationsClick(analytics.track, {
                        page_name: 'settings',
                        area: 'notifications',
                        element: 'success_sound',
                        ...(trackingSoundId ? { sound_id: trackingSoundId } : {}),
                      });
                      updateNotif({ successSoundId: sound.id });
                      playSound(sound.id);
                    }}
                  >
                    <span className="seg-title">{t(sound.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="settings-field">
              <label>{t('settings.notifyFailureSound')}</label>
              <div className="seg-control" role="group" aria-label={t('settings.notifyFailureSound')} style={{ '--seg-cols': FAILURE_SOUNDS.length } as React.CSSProperties}>
                {FAILURE_SOUNDS.map((sound) => (
                  <button
                    key={sound.id}
                    type="button"
                    className={'seg-btn' + (notif.failureSoundId === sound.id ? ' active' : '')}
                    aria-pressed={notif.failureSoundId === sound.id}
                    onClick={() => {
                      const trackingSoundId = soundIdToTracking(sound.id);
                      trackSettingsNotificationsClick(analytics.track, {
                        page_name: 'settings',
                        area: 'notifications',
                        element: 'failure_sound',
                        ...(trackingSoundId ? { sound_id: trackingSoundId } : {}),
                      });
                      updateNotif({ failureSoundId: sound.id });
                      playSound(sound.id);
                    }}
                  >
                    <span className="seg-title">{t(sound.labelKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="settings-subsection">
        <div className="settings-notify-card">
          <div className="settings-notify-card-header">
            <h4>{t('settings.notifyDesktop')}</h4>
            <div className="section-head-actions">
              <div className="seg-control" role="group" aria-label={t('settings.notifyDesktop')} style={{ '--seg-cols': 2 } as React.CSSProperties}>
                <button
                  type="button"
                  className={'seg-btn seg-btn--on' + (notif.desktopEnabled ? ' active' : '')}
                  aria-pressed={notif.desktopEnabled}
                  disabled={permission === 'unsupported'}
                  onClick={() => { if (!notif.desktopEnabled) void toggleDesktop(); }}
                >
                  <span className="seg-title">{t('common.active')}</span>
                </button>
                <button
                  type="button"
                  className={'seg-btn' + (!notif.desktopEnabled ? ' active' : '')}
                  aria-pressed={!notif.desktopEnabled}
                  disabled={permission === 'unsupported'}
                  onClick={() => { if (notif.desktopEnabled) void toggleDesktop(); }}
                >
                  <span className="seg-title">{t('common.inactive')}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        {permission === 'unsupported' ? (
          <p className="hint">{t('settings.notifyDesktopUnsupported')}</p>
        ) : null}
        {permission === 'denied' ? (
          <p className="hint">{t('settings.notifyDesktopBlocked')}</p>
        ) : null}
        {notif.desktopEnabled && permission === 'granted' ? (
          <>
            <Button variant="ghost" onClick={() => {
              trackSettingsNotificationsClick(analytics.track, {
                page_name: 'settings',
                area: 'notifications',
                element: 'send_test',
              });
              void sendTestNotification();
            }}>
              {t('settings.notifyTest')}
            </Button>
            {testStatus ? <p className="hint" role="status">{t(testStatus)}</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function testNotificationStatusText(
  result: Awaited<ReturnType<typeof showCompletionNotification>>,
):
  | 'settings.notifyTestSent'
  | 'settings.notifyDesktopBlocked'
  | 'settings.notifyDesktopUnsupported'
  | 'settings.notifyTestFailed' {
  if (result === 'shown') return 'settings.notifyTestSent';
  if (result === 'permission-denied') return 'settings.notifyDesktopBlocked';
  if (result === 'unsupported') return 'settings.notifyDesktopUnsupported';
  return 'settings.notifyTestFailed';
}
