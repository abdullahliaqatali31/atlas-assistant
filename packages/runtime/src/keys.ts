/**
 * Manage provider keys in the OS credential store.
 *   pnpm keys set ANTHROPIC_API_KEY      (prompts with hidden input)
 *   pnpm keys status
 *   pnpm keys delete ELEVENLABS_API_KEY
 */
import { isSecretName, osCredentialStore, SECRET_NAMES } from './credentials.ts'

const readHidden = (prompt: string) =>
  new Promise<string>((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) return reject(new Error('Run this in an interactive terminal.'))
    process.stdout.write(prompt)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(value.trim())
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else {
          value += ch
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })

const [action, name] = process.argv.slice(2)
const store = osCredentialStore()

if (action === 'status' || !action) {
  for (const n of SECRET_NAMES) console.log(`${n}: ${store.get(n) ? 'stored' : 'not stored'}${process.env[n] ? ' (env var also set; env wins)' : ''}`)
} else if ((action === 'set' || action === 'delete') && name && isSecretName(name)) {
  if (action === 'set') {
    const value = await readHidden(`${name}: `)
    if (!value) {
      console.error('Nothing entered; unchanged.')
      process.exit(1)
    }
    store.set(name, value)
    console.log(`${name} saved to the OS credential store.`)
  } else {
    store.delete(name)
    console.log(`${name} removed.`)
  }
} else {
  console.error(`Usage: pnpm keys <status|set|delete> <${SECRET_NAMES.join('|')}>`)
  process.exit(1)
}
