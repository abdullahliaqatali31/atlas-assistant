import { describe, expect, it } from 'vitest'

import { isBotToken, pairingCodeIn, splitMessage, toTelegramHtml } from './telegram.ts'

describe('telegram', () => {
  it('knows a bot token by its shape', () => {
    expect(isBotToken('1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1')).toBe(true)
    expect(isBotToken('not a token')).toBe(false)
  })

  it('turns Atlas’s Markdown into Telegram HTML, escaping the rest', () => {
    expect(toTelegramHtml('**Done** — see `atlas status` and [docs](https://x.org/a?b=1&c=2)')).toBe('<b>Done</b> — see <code>atlas status</code> and <a href="https://x.org/a?b=1&amp;c=2">docs</a>')
    expect(toTelegramHtml('## Today\n- a < b *now*')).toBe('<b>Today</b>\n- a &lt; b <i>now</i>')
    expect(toTelegramHtml('```ts\nconst a = 1 < 2\n```')).toBe('<pre>const a = 1 &lt; 2</pre>')
    expect(toTelegramHtml('file_name_here stays')).toBe('file_name_here stays')
  })

  it('splits long replies at paragraph ends', () => {
    const para = 'x'.repeat(3000)
    const parts = splitMessage(`${para}\n\n${para}`)
    expect(parts).toEqual([para, para])
    expect(splitMessage('short')).toEqual(['short'])
  })

  it('reads a pairing code from /start or alone', () => {
    expect(pairingCodeIn('/start 123456')).toBe('123456')
    expect(pairingCodeIn('123456')).toBe('123456')
    expect(pairingCodeIn('hello 123456')).toBeNull()
  })
})
