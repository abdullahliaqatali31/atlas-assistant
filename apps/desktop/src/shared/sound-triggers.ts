/**
 * Non-speech wake triggers: a double clap and a whistle (seeti). Plain signal
 * processing on 16 kHz mono audio, no model and no network. Feed every
 * captured block in order; each detector returns true once per trigger.
 */

export const SAMPLE_RATE = 16_000
/** Analysis block for claps: 16 ms, short enough to see a clap's sharp edge. */
const CLAP_BLOCK = 256

const rmsOf = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0
  for (let i = from; i < to; i++) s += a[i]! * a[i]!
  return Math.sqrt(s / Math.max(1, to - from))
}

/**
 * A clap is a loud, sudden burst that dies away within ~50 ms; speech and
 * music build up and last. Two claps 0.12–0.8 s apart make a double clap.
 */
export class DoubleClapDetector {
  private floor = 0.005
  private history: number[] = [] // recent block energies
  private pending: { at: number; peak: number } | null = null
  private lastClapAt = -Infinity
  private cooldownUntil = 0
  private t = 0 // samples seen

  push(samples: Float32Array): boolean {
    let fired = false
    for (let o = 0; o + CLAP_BLOCK <= samples.length; o += CLAP_BLOCK) {
      const e = rmsOf(samples, o, o + CLAP_BLOCK)
      const now = this.t / SAMPLE_RATE
      this.t += CLAP_BLOCK
      this.history.push(e)
      if (this.history.length > 8) this.history.shift()

      // A candidate waits a few blocks to prove it decays fast.
      if (this.pending) {
        const since = now - this.pending.at
        if (since <= 0.06) {
          if (e > this.pending.peak) this.pending.peak = e
          continue
        }
        const decayed = e < this.pending.peak * 0.3
        const clapAt = this.pending.at
        this.pending = null
        if (decayed) {
          if (clapAt - this.lastClapAt >= 0.12 && clapAt - this.lastClapAt <= 0.8 && clapAt >= this.cooldownUntil) {
            fired = true
            this.lastClapAt = -Infinity
            this.cooldownUntil = clapAt + 1.5
          } else this.lastClapAt = clapAt
        } else {
          // Sustained sound (speech, music): forget any half-finished double clap.
          this.lastClapAt = -Infinity
        }
        continue
      }

      const before = this.history.length >= 3 ? Math.max(this.history[this.history.length - 2]!, this.history[this.history.length - 3]!) : 0
      const loud = e > Math.max(0.06, this.floor * 10)
      const sharp = e > before * 4
      if (loud && sharp) this.pending = { at: now, peak: e }
      else if (!loud) this.floor = this.floor * 0.98 + e * 0.02
    }
    return fired
  }
}

// ── whistle ─────────────────────────────────────────────────

const FFT_N = 1024

/** In-place radix-2 FFT; returns magnitudes of the first N/2 bins. */
export const magnitudes = (input: Float32Array): Float32Array => {
  const n = FFT_N
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  for (let i = 0; i < n; i++) re[i] = (input[i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))) // Hann window
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const ar = re[i + k + len / 2]!
        const ai = im[i + k + len / 2]!
        const tr = ar * wr - ai * wi
        const ti = ar * wi + ai * wr
        re[i + k + len / 2] = re[i + k]! - tr
        im[i + k + len / 2] = im[i + k]! - ti
        re[i + k] = re[i + k]! + tr
        im[i + k] = im[i + k]! + ti
      }
    }
  }
  const out = new Float32Array(n / 2)
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i]!, im[i]!)
  return out
}

/**
 * A whistle is one strong, steady tone between ~600 and ~4000 Hz held for
 * at least ~0.4 s. Voices spread energy over many harmonics, so their peak
 * stands out far less from the rest of the band.
 */
export class WhistleDetector {
  private run = 0
  private lastHz = 0
  private cooldownUntil = 0
  private t = 0
  private buf = new Float32Array(0)

  push(samples: Float32Array): boolean {
    let fired = false
    const joined = new Float32Array(this.buf.length + samples.length)
    joined.set(this.buf)
    joined.set(samples, this.buf.length)
    let o = 0
    for (; o + FFT_N <= joined.length; o += FFT_N) {
      const frame = joined.subarray(o, o + FFT_N)
      const now = this.t / SAMPLE_RATE
      this.t += FFT_N
      const hz = this.tone(frame)
      const steady = hz > 0 && (this.lastHz === 0 || Math.abs(hz - this.lastHz) / this.lastHz < 0.12)
      this.run = steady ? this.run + 1 : hz > 0 ? 1 : 0
      this.lastHz = hz
      // 7 frames x 64 ms ≈ 0.45 s of the same tone.
      if (this.run >= 7 && now >= this.cooldownUntil) {
        fired = true
        this.run = 0
        this.cooldownUntil = now + 2
      }
    }
    this.buf = joined.slice(o)
    return fired
  }

  /** Frequency of a dominant tone in this frame, or 0. */
  private tone(frame: Float32Array): number {
    if (rmsOf(frame) < 0.01) return 0
    const mag = magnitudes(frame)
    const binHz = SAMPLE_RATE / FFT_N
    const lo = Math.floor(600 / binHz)
    const hi = Math.ceil(4000 / binHz)
    let peak = lo
    let total = 0
    for (let i = Math.floor(300 / binHz); i < Math.ceil(5000 / binHz); i++) total += mag[i]! * mag[i]!
    for (let i = lo; i <= hi; i++) if (mag[i]! > mag[peak]!) peak = i
    // Energy within ±2 bins of the peak versus the whole 300–5000 Hz band.
    let near = 0
    for (let i = peak - 2; i <= peak + 2; i++) near += mag[i]! * mag[i]!
    return total > 0 && near / total > 0.6 ? peak * binHz : 0
  }
}
