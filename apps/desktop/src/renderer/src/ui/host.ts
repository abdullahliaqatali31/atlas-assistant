/**
 * The computer Atlas runs on (Windows or a Mac), told by the status, so the
 * page names that computer's own things: where keys are kept, which Settings
 * app, the tray or the menu bar. Keys on the keyboard follow the device
 * looking at the page instead (shared/shortcuts.ts keyName).
 */
let host: 'windows' | 'mac' | 'other' = 'windows'

export const setHost = (h: 'windows' | 'mac' | 'other' | undefined) => {
  if (h) host = h
}

export const onMac = () => host === 'mac'

/** That computer's words for the things the page mentions. */
export const os = () =>
  onMac()
    ? {
        name: 'macOS',
        keyStore: 'the macOS Keychain',
        settings: 'System Settings',
        micSettings: 'System Settings › Privacy & Security › Microphone',
        starts: 'you log in to your Mac',
        tray: 'the menu bar',
        computer: 'this Mac',
      }
    : {
        name: 'Windows',
        keyStore: 'Windows Credential Manager',
        settings: 'Windows Settings',
        micSettings: 'Windows Settings › Privacy & security › Microphone',
        starts: 'Windows starts',
        tray: 'the Windows tray',
        computer: 'this PC',
      }
