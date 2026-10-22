/**
 * End-to-end check of a real setup: environment, local storage, the LLM key,
 * the voice key (TTS -> STT round trip) and configured MCP servers.
 *   pnpm doctor          quick checks (no billable calls beyond a key check)
 *   pnpm doctor --live   also one short LLM reply and one voice round trip
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadMcpConfig, McpHost } from '@assistant/mcp'
import { MemoryStore } from '@assistant/memory'
import { createLlm } from '@assistant/providers'
import { systemClock } from '@assistant/shared'

import { createVoice, loadConfig } from './config.ts'
import { osCredentialStore, withStoredSecrets } from './credentials.ts'

const live = process.argv.includes('--live')
let failed = 0
const pass = (msg: string) => console.log(`  ✓ ${msg}`)
const fail = (msg: string) => {
  failed++
  console.log(`  ✗ ${msg}`)
}
const warn = (msg: string) => console.log(`  ! ${msg}`)

try {
  process.loadEnvFile('.env')
} catch {
  // Optional.
}

console.log('Environment')
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
if (major > 22 || (major === 22 && minor >= 13)) pass(`Node ${process.versions.node}`)
else fail(`Node ${process.versions.node}; 22.13 or newer is required`)

const dir = mkdtempSync(join(tmpdir(), 'pa-doctor-'))
try {
  const store = new MemoryStore(join(dir, 'probe.db'), systemClock)
  store.remember({ kind: 'fact', statement: 'doctor probe', source: { kind: 'owner', origin: 'doctor', retrievedAt: 0 } })
  if (store.recall('probe').length === 1) pass('SQLite with FTS5 works')
  else fail('SQLite FTS5 search returned nothing')
  store.close()
} catch (error) {
  fail(`SQLite: ${(error as Error).message}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('Configuration')
const { config, problems, warnings } = loadConfig(withStoredSecrets(process.env, osCredentialStore()), process.cwd())
for (const w of warnings) warn(w)
for (const p of problems) fail(`${p.key}: ${p.message}`)
if (config) pass(`Owner "${config.owner.name || '(unset)'}", timezone ${config.owner.timezone} (UTC${config.owner.utcOffsetMin >= 0 ? '+' : ''}${config.owner.utcOffsetMin / 60})`)

if (config) {
  console.log('LLM provider')
  const llm = createLlm(config.llm)
  const health = await llm.healthCheck()
  if (health.ok) pass(`Key accepted for ${llm.model}`)
  else fail(health.error)

  if (health.ok && live) {
    try {
      let text = ''
      let cached = 0
      for await (const ev of llm.stream({ system: 'Reply with exactly: ok', turns: [{ role: 'user', content: 'ping' }], maxTokens: 64 })) {
        if (ev.type === 'text') text += ev.text
        if (ev.type === 'done') cached = ev.usage.cacheReadTokens
        if (ev.type === 'refused') throw new Error('request was refused')
      }
      pass(`Live reply: "${text.trim().slice(0, 40)}" (cache read ${cached} tokens)`)
    } catch (error) {
      fail(`Live reply failed: ${(error as Error).message}`)
    }
  }

  console.log('Voice provider')
  if (!config.voice) {
    warn('Skipped (developer mode without a voice key)')
  } else {
    const voice = createVoice(config.voice, config.owner.languages)
    const voiceLabel = config.voice.provider === 'azure' ? `Azure Speech (${config.voice.region}), voice ${config.voice.voiceId}` : `ElevenLabs voice ${config.voice.voiceId}`
    const vh = await voice.healthCheck()
    if (vh.ok) pass(`Key accepted for ${voiceLabel}`)
    else fail(vh.error)

    if (vh.ok && live) {
      try {
        // Azure's ur-PK voices read Urdu script; ElevenLabs handles Roman Urdu.
        const phrase = config.voice.provider === 'azure' ? 'السلام علیکم، آج دو ضروری کام ہیں۔' : 'Assalam o alaikum Hamza, aaj do zaroori kaam hain.'
        const chunks: Uint8Array[] = []
        const started = Date.now()
        let firstAudioMs = -1
        for await (const c of voice.tts.synthesize(phrase)) {
          if (firstAudioMs < 0) firstAudioMs = Date.now() - started
          chunks.push(c)
        }
        const bytes = chunks.reduce((n, c) => n + c.length, 0)
        pass(`TTS streamed ${bytes} bytes; first audio after ${firstAudioMs} ms`)
        const heard = await voice.stt.transcribe(new Blob(chunks.map(c => Uint8Array.from(c)), { type: 'audio/mpeg' }))
        pass(`STT heard: "${heard.text.trim()}" (language ${heard.languageCode ?? 'unknown'})`)
      } catch (error) {
        fail(`Voice round trip failed: ${(error as Error).message}`)
      }
    }
  }

  console.log('MCP servers')
  const mcpConfig = loadMcpConfig(config.mcpConfigPath)
  const enabled = Object.entries(mcpConfig.servers).filter(([, s]) => s.enabled)
  if (enabled.length === 0) {
    warn(`None enabled (${config.mcpConfigPath}); copy mcp.servers.example.json to add some`)
  } else {
    const host = new McpHost(mcpConfig, () => [], () => Date.now())
    const failures = await host.start()
    for (const f of failures) fail(`${f.server}: ${f.error}`)
    const tools = host.listTools()
    for (const [name] of enabled) {
      if (!failures.some(f => f.server === name)) pass(`${name}: ${tools.filter(t => t.server === name).length} tools`)
    }
    await host.stop()
  }
}

console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
if (!live && failed === 0) console.log('Run `pnpm doctor --live` to also test a real reply and a voice round trip.')
process.exit(failed === 0 ? 0 : 1)
