/** Contract for encrypted backups (Setup › Security). Main does the work; the renderer only asks. */

export const BC = {
  create: 'backup:create',
  restore: 'backup:restore',
} as const

export interface BackupBridge {
  /** Asks where to save, then writes an encrypted backup. Null when the owner cancelled the dialog. */
  create(passphrase: string): Promise<{ path: string; bytes: number } | null>
  /**
   * Asks for a backup file, checks the passphrase, keeps a safety copy of the
   * current data and replaces it; the app then restarts. Null when cancelled.
   */
  restore(passphrase: string): Promise<{ createdAt: string } | null>
}
