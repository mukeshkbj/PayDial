import assert from "node:assert/strict"
import { test } from "node:test"
import { frequencies, tones } from "./dtmf.ts"

const RATE = 8000

function linear(byte: number): number {
  const u = ~byte & 0xff
  const magnitude = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4)
  return u & 0x80 ? 0x84 - magnitude : magnitude - 0x84
}

function power(samples: number[], frequency: number): number {
  const k = 2 * Math.cos((2 * Math.PI * frequency) / RATE)
  let [a, b] = [0, 0]
  for (const sample of samples) [a, b] = [sample + k * a - b, a]
  return a * a + b * b - k * a * b
}

const ALL = [697, 770, 852, 941, 1209, 1336, 1477]

test("each key plays its two keypad tones and nothing else, with a gap after it", () => {
  const audio = [...tones("5#0")].map(linear)
  const tone = 1280
  const step = 1920
  for (const [k, key] of ["5", "#", "0"].entries()) {
    const slice = audio.slice(k * step, k * step + tone)
    const strongest = ALL.map((f) => [f, power(slice, f)] as const).sort((x, y) => y[1] - x[1])
    assert.deepEqual(strongest.slice(0, 2).map(([f]) => f).sort(), [...frequencies(key)].sort())
    assert.ok(strongest[2]![1] < strongest[1]![1] / 20)
    assert.ok(audio.slice(k * step + tone, (k + 1) * step).every((sample) => Math.abs(sample) < 8))
  }
  assert.equal(audio.length, 3 * step)
})

test("an unknown key is refused", () => {
  assert.throws(() => tones("1A"), /No keypad key A/)
})
