import { describe, expect, it } from 'vitest'

import { DoubleClapDetector, SAMPLE_RATE, WhistleDetector } from './sound-triggers.ts'

/** Deterministic pseudo-random noise so tests never flake. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1

const silence = (s: number, level = 0.002, seed = 1) => {
  const r = rng(seed)
  return Float32Array.from({ length: Math.round(s * SAMPLE_RATE) }, () => r() * level)
}
/** A clap: 25 ms of loud noise with a fast exponential decay. */
const clap = (seed = 7) => {
  const r = rng(seed)
  const n = Math.round(0.025 * SAMPLE_RATE)
  return Float32Array.from({ length: n }, (_, i) => r() * 0.7 * Math.exp(-i / (0.006 * SAMPLE_RATE)))
}
const tone = (hz: number, s: number, amp = 0.2, noise = 0.01) => {
  const r = rng(3)
  return Float32Array.from({ length: Math.round(s * SAMPLE_RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) + r() * noise)
}
/** Voice-like: a 140 Hz buzz with many harmonics, which a whistle check must reject. */
const voice = (s: number) =>
  Float32Array.from({ length: Math.round(s * SAMPLE_RATE) }, (_, i) => {
    let v = 0
    for (let h = 1; h <= 25; h++) v += Math.sin((2 * Math.PI * 140 * h * i) / SAMPLE_RATE) / h
    return v * 0.08
  })
const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
/** Feeds audio in 1024-sample blocks like the listener does; counts triggers. */
const feed = (d: { push(a: Float32Array): boolean }, audio: Float32Array) => {
  let fired = 0
  for (let o = 0; o < audio.length; o += 1024) if (d.push(audio.subarray(o, Math.min(audio.length, o + 1024)))) fired++
  return fired
}

describe('DoubleClapDetector', () => {
  it('fires on two claps about 0.35 s apart', () => {
    expect(feed(new DoubleClapDetector(), concat(silence(0.5), clap(), silence(0.33), clap(9), silence(0.5)))).toBe(1)
  })

  it('ignores a single clap', () => {
    expect(feed(new DoubleClapDetector(), concat(silence(0.5), clap(), silence(1.5)))).toBe(0)
  })

  it('ignores claps too far apart', () => {
    expect(feed(new DoubleClapDetector(), concat(silence(0.5), clap(), silence(1.2), clap(9), silence(0.5)))).toBe(0)
  })

  it('ignores sustained loud sound such as speech', () => {
    expect(feed(new DoubleClapDetector(), concat(silence(0.5), voice(1.2), silence(0.5)))).toBe(0)
  })
})

describe('WhistleDetector', () => {
  it('fires on a steady 1.5 kHz whistle of 0.7 s', () => {
    expect(feed(new WhistleDetector(), concat(silence(0.3), tone(1500, 0.7), silence(0.3)))).toBe(1)
  })

  it('ignores a short chirp', () => {
    expect(feed(new WhistleDetector(), concat(silence(0.3), tone(1500, 0.2), silence(0.3)))).toBe(0)
  })

  it('ignores a voice and plain noise', () => {
    expect(feed(new WhistleDetector(), concat(silence(0.3), voice(1.5), silence(0.3)))).toBe(0)
    expect(feed(new WhistleDetector(), silence(2, 0.2, 5))).toBe(0)
  })

  it('fires once per whistle, not once per frame', () => {
    expect(feed(new WhistleDetector(), concat(silence(0.3), tone(2000, 1.5), silence(0.3)))).toBe(1)
  })
})
