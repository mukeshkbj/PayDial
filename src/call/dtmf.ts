const RATE = 8000
const TONE_MS = 160
const GAP_MS = 80
const KEYS = ["123", "456", "789", "*0#"]
const ROWS = [697, 770, 852, 941]
const COLUMNS = [1209, 1336, 1477]

export const KEYPAD = /^[0-9*#]+$/

export function frequencies(key: string): [number, number] {
  const row = KEYS.findIndex((keys) => keys.includes(key))
  if (row < 0) throw new Error(`No keypad key ${key}`)
  return [ROWS[row]!, COLUMNS[KEYS[row]!.indexOf(key)]!]
}

export function tones(digits: string): Buffer {
  const tone = (RATE * TONE_MS) / 1000
  const gap = (RATE * GAP_MS) / 1000
  const out = Buffer.alloc(digits.length * (tone + gap), mulaw(0))
  ;[...digits].forEach((key, k) => {
    const [low, high] = frequencies(key)
    for (let i = 0; i < tone; i++) {
      const t = i / RATE
      out[k * (tone + gap) + i] = mulaw(Math.round(11_000 * (Math.sin(2 * Math.PI * low * t) + Math.sin(2 * Math.PI * high * t))))
    }
  })
  return out
}

function mulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0
  const magnitude = Math.min(Math.abs(sample), 32_635) + 0x84
  let exponent = 7
  for (let mask = 0x4000; !(magnitude & mask) && exponent > 0; mask >>= 1) exponent--
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f
  return ~(sign | (exponent << 4) | mantissa) & 0xff
}
