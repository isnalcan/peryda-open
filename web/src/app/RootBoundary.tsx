import { Component, type ReactNode } from 'react'
import { db } from '../data/db'

/** Preferences that are the reader's own choices about this device; a reset keeps them. */
const KEPT_PREFS = new Set(['rememberKeys', 'welcomed'])

/** Clears the stored preferences (language, theme, the open book…); books, threads and keys stay. */
export async function resetPreferences(): Promise<void> {
  const keys = (await db.prefs.toCollection().primaryKeys()) as string[]
  await db.prefs.bulkDelete(keys.filter((k) => !KEPT_PREFS.has(k)))
}

async function downloadBackup(): Promise<void> {
  const { backupFileName, exportBackup } = await import('../data/backup')
  const url = URL.createObjectURL(await exportBackup())
  const a = document.createElement('a')
  a.href = url
  a.download = backupFileName()
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

interface State {
  failed: boolean
  note: string | null
  busy: boolean
}

/**
 * The outermost safety net, outside the language provider (its text is fixed, in English and Turkish,
 * because the language setting itself may be what broke). Whatever went wrong, the reader can still
 * take their library out as a backup, or reset the preferences and start again.
 */
export class RootBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false, note: null, busy: false }

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  private run(job: () => Promise<void>, done: string | null) {
    this.setState({ busy: true, note: null })
    job().then(
      () => this.setState({ busy: false, note: done }),
      () => this.setState({ busy: false, note: 'That did not work. · Bu olmadı.' }),
    )
  }

  override render() {
    if (!this.state.failed) return this.props.children
    const { busy, note } = this.state
    return (
      <div className="error-screen root-error" role="alert">
        <p>
          <strong>Peryda could not start.</strong> Your books and notes are still on this device.
          <br />
          <strong>Peryda açılamadı.</strong> Kitapların ve notların hâlâ bu cihazda.
        </p>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={() => this.run(downloadBackup, 'Backup saved. · Yedek kaydedildi.')}>
            Export backup · Yedeği dışa aktar
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() =>
              this.run(async () => {
                await resetPreferences()
                location.reload()
              }, null)
            }
          >
            Reset preferences · Tercihleri sıfırla
          </button>
          <button type="button" className="primary-button" disabled={busy} onClick={() => location.reload()}>
            Reload · Yeniden yükle
          </button>
        </div>
        {note && <p role="status">{note}</p>}
      </div>
    )
  }
}
