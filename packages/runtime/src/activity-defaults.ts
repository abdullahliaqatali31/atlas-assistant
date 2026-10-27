/** Never recorded by window tracking unless the owner removes them: password managers, the lock screen and this app. */
export const DEFAULT_EXCLUDED_APPS = [
  'KeePass',
  'KeePassXC',
  '1Password',
  'Bitwarden',
  'LastPass',
  'Dashlane',
  'LockApp',
  'CredentialUIBroker',
  'Personal Assistant',
] as const
