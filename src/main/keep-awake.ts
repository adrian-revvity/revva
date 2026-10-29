import { powerSaveBlocker } from 'electron'
import { settingGet, settingSet } from './db'

const SETTING_KEY = 'keepAwake.enabled'

/**
 * Caffeinate equivalent: while active, Electron's powerSaveBlocker keeps the
 * machine from sleeping (and the display from dimming) so long agent runs and
 * script runs aren't interrupted by the laptop going to sleep.
 * 'prevent-display-sleep' is the same assertion `caffeinate -d` takes.
 */
class KeepAwake {
  private blockerId: number | null = null

  get enabled(): boolean {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)
  }

  /** Restore the state the user left the toggle in on last quit. */
  restore(): void {
    if (settingGet<boolean>(SETTING_KEY) === true) this.apply(true)
  }

  set(enabled: boolean): boolean {
    this.apply(enabled)
    settingSet(SETTING_KEY, enabled)
    return this.enabled
  }

  private apply(enabled: boolean): void {
    if (enabled && this.blockerId === null) {
      this.blockerId = powerSaveBlocker.start('prevent-display-sleep')
    } else if (!enabled && this.blockerId !== null) {
      powerSaveBlocker.stop(this.blockerId)
      this.blockerId = null
    }
  }
}

export const keepAwake = new KeepAwake()
