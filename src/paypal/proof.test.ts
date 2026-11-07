import assert from "node:assert/strict"
import { test } from "node:test"
import { scriptedCalls } from "../call/scripted.ts"
import { sqliteCards } from "../cards.ts"
import { sqliteErrands } from "../errandStore.ts"
import { createErrands } from "../errands.ts"
import { fakePayPal } from "./fake.ts"
import { proofTable } from "./proof.ts"

test("the proof table reads each order back from PayPal and checks the receipt hash against its custom_id", async () => {
  const paypal = fakePayPal("http://dial.test")
  const store = sqliteErrands(":memory:")
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store, publicUrl: "http://dial.test" })
  const { id } = await errands.start({ mode: "order", shop: { name: "Sam's Bagels", phone: "sim:happy" }, request: "a dozen bagels", maxCents: 2_000, customerName: "Maya" })
  for (let i = 0; i < 200 && errands.get(id)!.state.kind !== "awaiting_approval"; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") return assert.fail(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)
  await errands.confirmPickup(id, true)

  const table = await proofTable(store.load(), paypal)
  assert.match(table, new RegExp(`\\| Sam's Bagels \\| \\$16\\.00 \\| paid \\| ${state.orderId} \\| COMPLETED \\| CAPTURED \\| \\S+ COMPLETED \\| yes \\|`))

  const tampered = store.load().map((record) => ({ ...record, errand: { ...record.errand, transcript: record.errand.transcript.map((line, i) => (i === 0 ? { ...line, text: "edited" } : line)) } }))
  assert.match(await proofTable(tampered, paypal), /\| no \|$/m)
})
