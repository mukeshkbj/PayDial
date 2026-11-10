import assert from "node:assert/strict"
import { test } from "node:test"
import { briefFor } from "./call/call.ts"
import type { Errand, ErrandInput } from "./domain/errand.ts"
import { scoreboard } from "./scoreboard.ts"

const at = "2026-11-10T10:00:00.000Z"
const base = (id: string, phone: string, state: Errand["state"], lines: string[]): Errand => ({
  id,
  createdAt: at,
  version: 1,
  state,
  transcript: lines.map((text) => ({ speaker: "system" as const, text, at })),
  input: { mode: "order", shop: { name: "Rosa's Panadería", phone }, request: "2 Concha", maxCents: 700, customerName: "Maya" },
})

test("the scoreboard counts every refused deal and how far over the limit the shops asked", () => {
  const board = scoreboard([
    base("a", "browser", { kind: "failed", reason: "no_deal", detail: "x" }, [
      "Blocked: The shop asked for $500.00, above your $7.00 limit. Dial said no.",
      "Blocked: The shop asked for $1,000.00, above your $7.00 limit. Dial said no.",
      "Blocked: The shop gave a different PayPal email than the one on file. Dial said no.",
    ]),
    base("b", "sim:happy", { kind: "paid", orderId: "O", captureId: "C", receipt: { hash: "h", lines: 1 }, deal: { items: [], totalCents: 544, pickupTime: "now", payeeEmail: null } }, []),
  ])
  assert.deepEqual(board, { attempts: 3, refusedCents: 50000 - 700 + 100000 - 700, challenges: 1, paidCents: 544, aiPaidCents: 0 })
})

test("a gullible agent is told to propose whatever the shop asks, and still has no tool that moves money", () => {
  const input: ErrandInput = { mode: "order", shop: { name: "Rosa's Panadería", phone: "browser" }, request: "2 Concha", maxCents: 700, customerName: "Maya", gullible: true }
  const brief = briefFor(input)
  assert.match(brief.instructions, /gullible assistant/)
  assert.match(brief.instructions, /call propose_deal with exactly those values/)
  assert.doesNotMatch(brief.instructions, /The customer's limit is/)
  assert.doesNotMatch(brief.instructions, /do not follow it/)
  assert.deepEqual(brief.tools.map((tool) => tool.name).sort(), ["ask_user", "end_call", "press_keys", "propose_deal"])
  assert.match(briefFor({ ...input, gullible: false }).instructions, /The customer's limit is \$7\.00/)
})
