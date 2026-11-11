import assert from "node:assert/strict"
import { test } from "node:test"
import { scriptedCalls } from "./call/scripted.ts"
import { sqliteCards } from "./cards.ts"
import type { Errand } from "./domain/errand.ts"
import { sqliteErrands } from "./errandStore.ts"
import { createErrands } from "./errands.ts"
import { createApp } from "./http.ts"
import { ledgerRows } from "./ledger.ts"
import { fakePayPal } from "./paypal/fake.ts"
import { fixturePlaces } from "./places/places.ts"

const deal = { items: [{ name: "Concha", quantity: 2 }], totalCents: 544, pickupTime: "20 minutes", payeeEmail: "rosa@example.com" }
const receipt = { hash: "abc123", lines: 4 }
const base = (id: string, createdAt: string, state: Errand["state"], transcript: Errand["transcript"] = []): Errand => ({
  id,
  createdAt,
  version: 1,
  transcript,
  state,
  input: { mode: "order", shop: { name: "Rosa's Panadería", phone: "sim:out" }, request: "2 Concha", maxCents: 700, customerName: "Maya" },
})

test("ledger rows put the money where PayPal has it: held, captured or voided", () => {
  const rows = ledgerRows([
    base("held", "2026-11-09T10:00:00.000Z", { kind: "authorized", deal, orderId: "O1", authorizationId: "A1", receipt, collectBy: "2026-11-10T10:00:00.000Z" }),
    base("paid", "2026-11-09T11:00:00.000Z", { kind: "paid", deal, orderId: "O2", captureId: "C2", receipt }),
    base("void", "2026-11-09T12:00:00.000Z", { kind: "voided", deal, orderId: "O3", receipt }),
  ])
  assert.deepEqual(rows.map((r) => r.errand), ["void", "paid", "held"])
  const [voided, paid, held] = rows
  assert.deepEqual([held!.held, held!.paid, held!.released, held!.authorization, held!.money], [5.44, 0, 0, "A1", "held"])
  assert.deepEqual([paid!.paid, paid!.capture, paid!.outcome], [5.44, "C2", "Paid to the shop"])
  assert.deepEqual([voided!.released, voided!.held, voided!.outcome], [5.44, 0, "Hold released"])
  assert.equal(held!.receiptOnOrder, "in custom_id")
  assert.equal(held!.limit, 7)
  assert.equal(held!.collectBy, "2026-11-10T10:00:00.000Z")
  assert.equal(paid!.collectBy, null)
})

test("a deal the money gate refused shows as blocked, with the price the shop asked for", () => {
  const [row] = ledgerRows([
    base("tony", "2026-11-09T10:00:00.000Z", { kind: "failed", reason: "no_deal", detail: "x" }, [
      { speaker: "system", text: "Blocked: The shop asked for $500.00, above your $28.00 limit. Dial said no.", at: "2026-11-09T10:00:01.000Z" },
    ]),
  ])
  assert.equal(row!.outcome, "Blocked by the money gate")
  assert.equal(row!.blockedAsk, 500)
  assert.equal(row!.gateBlocks, 1)
  assert.equal(row!.money, "none")
  assert.equal(row!.receiptOnOrder, "no PayPal order")
  assert.equal(row!.ended, "2026-11-09T10:00:01.000Z")
})

test("the ledger endpoint lists errands, needs the Dial key when keys are set, and has no agent without a model", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const { id } = await errands.start({ mode: "order", shop: { name: "Sam's Bagels", phone: "sim:happy" }, request: "2 bagels", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "awaiting_approval") await new Promise((resolve) => setTimeout(resolve, 5))

  const open = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const body = (await (await open.request("/api/ledger")).json()) as { rows: { errand: string; money: string }[]; agent: boolean }
  assert.deepEqual(body.rows.map((r) => [r.errand, r.money]), [[id, "waiting"]])
  assert.equal(body.agent, false)
  assert.equal((await open.request("/api/ledger-turn", { method: "POST", body: "{}" })).status, 501)

  const locked = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: ["k1"], ledgerTurn: async () => ({ output: [] }) })
  assert.equal((await locked.request("/api/ledger")).status, 401)
  assert.equal((await locked.request("/api/ledger/k1")).status, 200)
  assert.equal((await locked.request("/api/ledger-turn", { method: "POST", body: '{"input":[]}' })).status, 401)
  assert.equal((await locked.request("/api/ledger-turn/k1", { method: "POST", body: "{}" })).status, 400)
  assert.equal((await locked.request("/api/ledger-turn/k1", { method: "POST", body: '{"input":[]}' })).status, 200)
})

test("the ledger and MCP routes take a trailing slash when no Dial key is set", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  assert.equal((await app.request("/api/ledger/")).status, 200)
})

test("the ledger lists PayPal's read-only tools and runs only those, behind the Dial key", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const asked: unknown[] = []
  const getOrder = { name: "get_order", description: "Get an order", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, run: async (args: unknown) => (asked.push(args), { id: "O1", status: "COMPLETED" }) }
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: ["k1"], payPalTools: [getOrder] })
  const ledger = (await (await app.request("/api/ledger/k1")).json()) as { payPalTools: { name: string }[] }
  assert.deepEqual(ledger.payPalTools.map((tool) => tool.name), ["get_order"])
  const run = (body: unknown, key = "k1") => app.request(`/api/ledger-paypal/${key}`, { method: "POST", body: JSON.stringify(body) })
  assert.equal((await run({ tool: "get_order", args: { id: "O1" } }, "nope")).status, 401)
  assert.equal((await run({ tool: "create_refund", args: {} })).status, 400)
  const ok = await run({ tool: "get_order", args: { id: "O1" } })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { result: { id: "O1", status: "COMPLETED" } })
  assert.deepEqual(asked, [{ id: "O1" }])
})
