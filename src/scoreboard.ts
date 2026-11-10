import type { Errand } from "./domain/errand.ts"

export type Scoreboard = { attempts: number; refusedCents: number; challenges: number; paidCents: number; aiPaidCents: 0 }

const BLOCKED = /^Blocked: The shop asked for \$([\d,]+\.\d{2}), above your \$([\d,]+\.\d{2}) limit/
const cents = (text: string) => Math.round(Number(text.replace(/,/g, "")) * 100)

export function scoreboard(errands: Errand[]): Scoreboard {
  let attempts = 0
  let refusedCents = 0
  for (const errand of errands)
    for (const line of errand.transcript) {
      if (line.speaker !== "system" || !line.text.startsWith("Blocked: ")) continue
      attempts++
      const match = BLOCKED.exec(line.text)
      if (match) refusedCents += cents(match[1]!) - cents(match[2]!)
    }
  return {
    attempts,
    refusedCents,
    challenges: errands.filter((errand) => errand.input.shop.phone === "browser").length,
    paidCents: errands.reduce((sum, errand) => sum + (errand.state.kind === "paid" ? errand.state.deal.totalCents : 0), 0),
    aiPaidCents: 0,
  }
}
