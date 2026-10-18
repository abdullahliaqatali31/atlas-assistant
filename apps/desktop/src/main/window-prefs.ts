/**
 * The main window's web preferences. Developer tools exist only in a dev
 * run: in the installed app they would hand anyone at the keyboard the
 * preload bridges directly, past the owner lock and the UI's own checks.
 */
export const mainWebPreferences = (preload: string, isDev: boolean) =>
  ({
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    devTools: isDev,
    spellcheck: false,
    // Spoken replies arrive after the click that asked for them.
    autoplayPolicy: 'no-user-gesture-required',
  }) as const
