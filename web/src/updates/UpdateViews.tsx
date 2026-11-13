import { useI18n } from '../i18n/I18n'
import type { DesktopUpdates } from './desktopUpdates'

/**
 * The Windows app's two update moments, as a small card in the corner that never blocks reading:
 * the one-time "check automatically?" question, and "a new version is ready".
 */
export function UpdateNotice({ updates }: { updates: DesktopUpdates }) {
  const { t } = useI18n()
  if (updates.asking) {
    return (
      <aside className="update-card" role="dialog" aria-labelledby="update-ask-title">
        <h3 id="update-ask-title">{t.updatesAsk}</h3>
        <p>{t.updatesHint}</p>
        <p>{t.updatesAskLater}</p>
        <div className="update-actions">
          <button type="button" className="ghost-button" onClick={() => updates.choose(false)}>{t.updatesDeny}</button>
          <button type="button" className="primary-button" onClick={() => updates.choose(true)}>{t.updatesAllow}</button>
        </div>
      </aside>
    )
  }
  if (updates.found) {
    const installing = updates.status === 'installing'
    return (
      <aside className="update-card" role="status">
        <h3>{t.updateReady(updates.found)}</h3>
        {installing && <p>{t.updateInstalling}</p>}
        {updates.status === 'failed' && <p>{t.updateFailed}</p>}
        <div className="update-actions">
          <button type="button" className="ghost-button" disabled={installing} onClick={updates.later}>{t.updateLater}</button>
          <button type="button" className="primary-button" disabled={installing} onClick={updates.install}>{t.updateInstall}</button>
        </div>
      </aside>
    )
  }
  return null
}

/** Settings → Updates (Windows app only): the automatic check on or off, and a check now. */
export function UpdateSection({ updates }: { updates: DesktopUpdates }) {
  const { t } = useI18n()
  return (
    <section className="dialog-updates">
      <h3>{t.updates}</h3>
      {updates.available ? (
        <>
          <label className="check-row">
            <input type="checkbox" checked={updates.choice === 'on'} onChange={(e) => updates.choose(e.target.checked)} />
            {t.updatesAuto}
          </label>
          <p className="dialog-note">{t.updatesHint}</p>
          <div className="update-row">
            <span className="update-version">{t.versionIs(updates.version)}</span>
            <span className="update-result" role="status">
              {updates.status === 'upToDate' ? t.upToDate : updates.status === 'failed' && !updates.found ? t.updateFailed : ''}
            </span>
            <button type="button" className="ghost-button" disabled={updates.status === 'checking' || updates.status === 'installing'} onClick={updates.checkNow}>
              {t.checkNow}
            </button>
          </div>
        </>
      ) : (
        <p className="dialog-note">{t.updatesUnavailable}</p>
      )}
    </section>
  )
}
