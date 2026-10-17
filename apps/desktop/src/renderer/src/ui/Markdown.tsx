/**
 * The small Markdown subset replies use (bold, italics, code, lists,
 * headings, links), rendered as React elements: never as HTML, so a reply
 * cannot inject markup. Each paragraph picks its own direction, so Urdu
 * lines read right to left next to English ones.
 */
import { Fragment, type ReactNode } from 'react'

type Block = { type: 'p' | 'h'; text: string } | { type: 'ul' | 'ol'; items: string[] } | { type: 'code'; text: string }

export const parseBlocks = (src: string): Block[] => {
  const blocks: Block[] = []
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) body.push(lines[i]!)
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'h', text: heading[1]! })
      continue
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flush()
      const type = bullet ? 'ul' : 'ol'
      const last = blocks.at(-1)
      const item = (bullet ?? numbered)![1]!
      if (last && last.type === type) last.items.push(item)
      else blocks.push({ type, items: [item] })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    para.push(line)
  }
  flush()
  return blocks
}

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|(?<![\w*])\*[^*\n]+\*(?![\w*])|(?<![\w_])_[^_\n]+_(?![\w_]))/g

/** Inline marks inside one block. Links show their text and open in the browser. */
export const inline = (text: string): ReactNode[] =>
  text.split(INLINE).map((part, i) => {
    if (i % 2 === 0) return part
    if (part.startsWith('**') || part.startsWith('__')) return <strong key={i}>{inline(part.slice(2, -2))}</strong>
    if (part.startsWith('`')) return <code key={i} className="rounded bg-surface-strong px-1 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>
    if (part.startsWith('[')) {
      const m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part)!
      return (
        <a key={i} href={m[2]} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
          {m[1]}
        </a>
      )
    }
    return <em key={i}>{inline(part.slice(1, -1))}</em>
  })

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((b, i) => {
        const gap = i > 0 ? 'mt-2' : ''
        switch (b.type) {
          case 'h':
            return (
              <p key={i} dir="auto" className={`${gap} font-semibold`}>
                {inline(b.text)}
              </p>
            )
          case 'code':
            return (
              <pre key={i} className={`${gap} overflow-x-auto rounded-lg bg-bg p-2 font-mono text-xs`}>
                {b.text}
              </pre>
            )
          case 'ul':
          case 'ol': {
            const List = b.type === 'ul' ? 'ul' : 'ol'
            return (
              <List key={i} dir="auto" className={`${gap} space-y-0.5 ps-5 ${b.type === 'ul' ? 'list-disc' : 'list-decimal'} marker:text-muted`}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </List>
            )
          }
          default:
            return (
              <p key={i} dir="auto" className={gap}>
                {b.text.split('\n').map((ln, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(ln)}
                  </Fragment>
                ))}
              </p>
            )
        }
      })}
    </>
  )
}
