import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Brief, CallHandlers, PlaceCall } from "./call/call.ts"
import { scriptedCalls } from "./call/scripted.ts"
import { dealProblem, isFinished, type Errand, type ErrandInput, type ErrandState } from "./domain/errand.ts"
import { sqliteCards } from "./cards.ts"
import { sqliteErrands, type ErrandStore } from "./errandStore.ts"
import { createErrands } from "./errands.ts"
import { fakePayPal, type FakePayPal } from "./paypal/fake.ts"
import type { PayPal } from "./paypal/rest.ts"
import { receiptHash } from "./receipt.ts"
import { fakeSms } from "./sms/sms.ts"

const PUBLIC_URL = "http://dial.test"

function setup() {
  const paypal = fakePayPal(PUBLIC_URL)
  const cards = sqliteCards(":memory:")
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards, store: sqliteErrands(":memory:"), publicUrl: PUBLIC_URL, answerTimeoutMs: 200 })
  return { paypal, errands, cards }
}

function order(script: string, maxCents = 2_000): ErrandInput {
  return {
    mode: "order",
    shop: { name: "Sam's Bagels", phone: `sim:${script}` },
    request: "a dozen bagels",
    maxCents,
    customerName: "Maria",
  }
}

function until(errands: ReturnType<typeof setup>["errands"], id: string, done: (errand: Errand) => boolean): Promise<Errand> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out in state ${errands.get(id)?.state.kind}`)), 2_000)
    const check = (errand: Errand) => {
      if (!done(errand)) return
      clearTimeout(timer)
      stop()
      resolve(errand)
    }
    const stop = errands.watch(id, check)
    check(errands.get(id)!)
  })
}

const callEnded = (errand: Errand) => errand.transcript.some((line) => line.text.startsWith("Call ended"))
const inState = (kind: ErrandState["kind"]) => (errand: Errand) => errand.state.kind === kind

test("the money gate rejects deals the customer did not allow", () => {
  const input = order("happy", 2_000)
  const deal = { items: [{ name: "bagels", quantity: 12 }], totalCents: 1_500, pickupTime: "8am", payeeEmail: "sam@bagels.example" }
  assert.equal(dealProblem(input, deal), undefined)
  assert.match(dealProblem(input, { ...deal, totalCents: 2_001 })!, /above the customer's limit/)
  assert.match(dealProblem(input, { ...deal, totalCents: 0 })!, /positive/)
  assert.match(dealProblem(input, { ...deal, items: [] })!, /no items/)
  assert.match(dealProblem(input, { ...deal, payeeEmail: "sam at bagels" })!, /not a valid email/)
  assert.match(dealProblem({ ...input, mode: "inquire" }, deal)!, /only asks questions/)
  assert.equal(dealProblem(input, deal, "sam@bagels.example"), undefined)
  assert.match(dealProblem(input, { ...deal, payeeEmail: "thief@example.com" }, "sam@bagels.example")!, /on file/)
  assert.equal(dealProblem(input, { ...deal, payeeEmail: "Sam@Bagels.example" }, "sam@bagels.example"), undefined)
  assert.equal(dealProblem(input, { ...deal, payeeEmail: null }, "sam@bagels.example"), undefined)
})

test("happy path: approve on PayPal, authorize during the call, capture at pickup", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("happy"))

  const awaiting = await until(errands, id, inState("awaiting_approval"))
  assert.equal(awaiting.state.kind, "awaiting_approval")
  if (awaiting.state.kind !== "awaiting_approval") return
  const placed = paypal.peek(awaiting.state.orderId)!
  assert.equal(placed.totalCents, 1_600)
  assert.equal(placed.payeeEmail, "orders@samsbagels.example")

  paypal.approve(awaiting.state.orderId)
  await errands.approved(id)
  await until(errands, id, callEnded)
  assert.equal(errands.get(id)!.state.kind, "authorized")
  assert.ok(errands.get(id)!.transcript.some((line) => line.text.includes("held on PayPal") && line.text.includes("pays at the counter")))

  await errands.confirmPickup(id, true)
  assert.equal(errands.get(id)!.state.kind, "paid")
  assert.equal(paypal.peek(placed.id)!.authorization!.status, "CAPTURED")
})

test("a simulated shop gives a set payee, so a real sandbox account can take the money", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0, "sb-shop@business.example.com"), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl: PUBLIC_URL })
  const { id } = await errands.start(order("happy"))

  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail(awaiting.state.kind)
  assert.equal(paypal.peek(awaiting.state.orderId)!.payeeEmail, "sb-shop@business.example.com")
})

test("a problem at pickup voids the hold instead of capturing it", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("happy"))
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()
  paypal.approve(awaiting.state.orderId)
  await errands.approved(id)

  await errands.confirmPickup(id, false)
  assert.equal(errands.get(id)!.state.kind, "voided")
  assert.equal(paypal.peek(awaiting.state.orderId)!.authorization!.status, "VOIDED")
})

test("the agent asks the customer mid-call and continues with the answer", async () => {
  const { errands } = setup()
  const { id } = await errands.start(order("out_of_stock"))

  const asking = await until(errands, id, inState("asking"))
  if (asking.state.kind !== "asking") return assert.fail()
  assert.deepEqual(asking.state.options, ["Yes, plain is fine", "No, skip it"])

  errands.answer(id, "Yes, plain is fine")
  await until(errands, id, inState("awaiting_approval"))
})

test("an accepted substitute is what the deal and the PayPal order name", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start({ ...order("out_of_stock"), request: "2 Concha" })
  const asking = await until(errands, id, inState("asking"))
  assert.equal(asking.state.kind === "asking" && asking.state.question, "Sam's Bagels is out of Concha. Is the plain version okay?")
  errands.answer(id, "Yes, plain is fine")
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()
  assert.deepEqual(awaiting.state.deal.items, [{ name: "Concha, plain", quantity: 2 }])
  assert.match(paypal.peek(awaiting.state.orderId)!.description, /2 Concha, plain/)
})

test("declining the substitution ends the call with no order", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("out_of_stock"))
  await until(errands, id, inState("asking"))

  errands.answer(id, "No, skip it")
  const ended = await until(errands, id, callEnded)
  assert.equal(ended.state.kind, "failed")
  assert.equal(paypal.peek("FAKE-ORDER-1"), undefined)
})

test("an unanswered question fails the errand as user_unavailable", async () => {
  const { errands } = setup()
  const { id } = await errands.start(order("out_of_stock"))
  const ended = await until(errands, id, callEnded)
  assert.deepEqual(ended.state.kind === "failed" && ended.state.reason, "user_unavailable")
})

test("a shop that asks for more money never gets an order above the limit", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("price_injection"))

  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()
  assert.equal(paypal.peek(awaiting.state.orderId)!.totalCents, 1_600)
  assert.equal(paypal.peek("FAKE-ORDER-2"), undefined)
  assert.ok(awaiting.transcript.some((line) => line.speaker === "system" && line.text.includes("above your $20.00 limit")))
})

test("a shop without PayPal is paid at pickup and no order is created", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("no_paypal"))
  const ended = await until(errands, id, callEnded)
  assert.equal(ended.state.kind, "pay_at_pickup")
  assert.equal(paypal.peek("FAKE-ORDER-1"), undefined)
})

test("declining on PayPal ends the call and fails the errand", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("happy"))
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()

  paypal.cancel(awaiting.state.orderId)
  await errands.declined(id)
  const ended = await until(errands, id, callEnded)
  assert.deepEqual(ended.state.kind === "failed" && ended.state.reason, "user_declined")
})

test("a PayPal return before approval changes nothing, and the real approval still holds the money", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("happy"))
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()

  await assert.rejects(errands.approved(id), /CREATED on PayPal/)
  assert.equal(errands.get(id)!.state.kind, "awaiting_approval")

  paypal.approve(awaiting.state.orderId)
  await errands.approved(id)
  assert.equal(errands.get(id)!.state.kind, "authorized")
})

test("inquire mode reports findings and never touches PayPal", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start({
    mode: "inquire",
    shop: { name: "Sam's Bagels", phone: "sim:inquiry" },
    request: "Do you have sesame bagels today?",
    customerName: "Maria",
  })
  const ended = await until(errands, id, callEnded)
  assert.equal(ended.state.kind, "answered")
  assert.equal(paypal.peek("FAKE-ORDER-1"), undefined)
})

function manual(paypal = fakePayPal(PUBLIC_URL), port: PayPal = paypal, cards = sqliteCards(":memory:"), store: ErrandStore = sqliteErrands(":memory:")) {
  let handlers: CallHandlers | undefined
  const briefs: Brief[] = []
  const errands = createErrands({
    paypal: port,
    placeCall: async (_target, brief, call) => {
      handlers = call
      briefs.push(brief)
      return { inform() {}, press() {}, hangup() {} }
    },
    cards,
    store,
    publicUrl: PUBLIC_URL,
    answerTimeoutMs: 100,
  })
  return { paypal, errands, cards, store, briefs, agent: () => handlers! }
}

function gate() {
  let release = () => {}
  const opened = new Promise<void>((resolve) => (release = resolve))
  return { opened, release }
}

const agreed = { items: [{ name: "Sesame bagel", quantity: 2 }], total_cents: 900, pickup_time: "9am", payee_email: "sam@bagels.example" }

async function held() {
  const setup = manual()
  const { id } = await setup.errands.start(order("happy"))
  await setup.agent().onToolCall("propose_deal", agreed)
  const state = setup.errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(`expected awaiting_approval, got ${state.kind}`)
  setup.paypal.approve(state.orderId)
  await setup.errands.approved(id)
  return { ...setup, id }
}

test("a deal or question after the hold exists changes nothing", async () => {
  const { errands, agent, id } = await held()
  assert.match(await agent().onToolCall("propose_deal", { ...agreed, total_cents: 500 }), /already/)
  assert.match(await agent().onToolCall("ask_user", { question: "Change the order?" }), /cannot/)
  assert.equal(errands.get(id)!.state.kind, "authorized")
})

test("PayPal returning twice authorizes once", async () => {
  const { paypal, errands, agent } = manual()
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await Promise.all([errands.approved(id), errands.approved(id)])
  assert.equal(errands.get(id)!.state.kind, "authorized")
})

test("confirming pickup twice captures once", async () => {
  const { errands, id } = await held()
  await Promise.all([errands.confirmPickup(id, true), errands.confirmPickup(id, true)])
  assert.equal(errands.get(id)!.state.kind, "paid")
})

test("a second deal or a question while PayPal sets up the order is refused", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const slow = gate()
  const { errands, agent } = manual(paypal, { ...paypal, createOrder: async (request) => slow.opened.then(() => paypal.createOrder(request)) })
  const { id } = await errands.start(order("happy"))
  const first = agent().onToolCall("propose_deal", agreed)
  const second = agent().onToolCall("propose_deal", { ...agreed, total_cents: 800 })
  const question = agent().onToolCall("ask_user", { question: "Plain instead?" })
  slow.release()
  assert.match(await second, /already/)
  assert.match(await question, /cannot/)
  await first
  const state = errands.get(id)!.state
  assert.equal(state.kind, "awaiting_approval")
  assert.equal(state.kind === "awaiting_approval" && state.deal.totalCents, 900)
  assert.equal(paypal.peek("FAKE-ORDER-2"), undefined)
})

test("a cancel that arrives while PayPal authorizes is refused and never shows as declined", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const slow = gate()
  const { errands, agent } = manual(paypal, { ...paypal, authorize: async (orderId) => slow.opened.then(() => paypal.authorize(orderId)) })
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  const seen: string[] = []
  errands.watch(id, (errand) => seen.push(errand.state.kind))
  const approving = errands.approved(id)
  const declining = errands.declined(id)
  slow.release()
  await assert.rejects(declining, /authoriz/)
  await approving
  assert.equal(errands.get(id)!.state.kind, "authorized")
  assert.ok(!seen.includes("failed"), seen.join(", "))
})

test("a void that arrives while PayPal captures is refused, not dropped in silence", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const slow = gate()
  const { errands, agent } = manual(paypal, { ...paypal, capture: async (authorizationId) => slow.opened.then(() => paypal.capture(authorizationId)) })
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)
  const capturing = errands.confirmPickup(id, true)
  const voiding = errands.confirmPickup(id, false)
  const twice = errands.confirmPickup(id, true)
  slow.release()
  await assert.rejects(voiding, /captur/)
  await Promise.all([capturing, twice])
  assert.equal(errands.get(id)!.state.kind, "paid")
})

test("when PayPal authorizes but the answer is lost, Dial finds the hold instead of failing", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const { errands, agent } = manual(paypal, {
    ...paypal,
    authorize: async (orderId) => {
      await paypal.authorize(orderId)
      throw new Error("socket hang up")
    },
  })
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)
  const after = errands.get(id)!.state
  assert.equal(after.kind, "authorized")
  assert.equal(after.kind === "authorized" && after.authorizationId, "FAKE-AUTH-1")
})

test("a Shop Card that fails to save does not undo the hold", async () => {
  const cards = sqliteCards(":memory:")
  const { paypal, errands, agent } = manual(undefined, undefined, {
    ...cards,
    record: () => {
      throw new Error("SQLITE_BUSY")
    },
  })
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)
  assert.equal(errands.get(id)!.state.kind, "authorized")
})

test("a pay-at-pickup deal keeps the PayPal email on file, so a new email is still blocked", async () => {
  const { paypal, errands, cards, agent } = manual()
  const first = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(first.id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(first.id)

  await errands.start(order("happy"))
  assert.match(await agent().onToolCall("propose_deal", { ...agreed, payee_email: null }), /at pickup/)
  assert.equal(cards.get("sim:happy")!.payeeEmail, "sam@bagels.example")

  await errands.start(order("happy"))
  assert.match(await agent().onToolCall("propose_deal", { ...agreed, payee_email: "thief@evil.example" }), /Rejected/)
})

test("after the call ends, an open question can no longer change the errand", async () => {
  const { errands, agent } = manual()
  const { id } = await errands.start(order("happy"))
  const question = agent().onToolCall("ask_user", { question: "Plain instead?" })
  agent().onEnded("shop hung up")
  assert.throws(() => errands.answer(id, "Yes"))
  await question
  const state = errands.get(id)!.state
  assert.equal(state.kind === "failed" && state.reason, "no_deal")
})

test("the customer's transcript and outcome carry no agent instructions", async () => {
  const { errands } = setup()
  const injected = await errands.start(order("price_injection", 3_300))
  const done = await until(errands, injected.id, inState("awaiting_approval"))
  const blocked = done.transcript.find((line) => line.speaker === "system" && line.text.startsWith("Blocked:"))
  assert.equal(blocked?.text, "Blocked: The shop asked for $500.00, above your $33.00 limit. Dial said no.")

  const declined = await errands.start(order("out_of_stock"))
  await until(errands, declined.id, inState("asking"))
  errands.answer(declined.id, "No, skip it")
  const failed = await until(errands, declined.id, (errand) => errand.state.kind === "failed" && callEnded(errand))

  for (const errand of [done, failed]) {
    const shown = [...errand.transcript.filter((line) => line.speaker === "system").map((line) => line.text), errand.state.kind === "failed" ? errand.state.detail : ""]
    for (const text of shown) assert.doesNotMatch(text, /end_call|Do not accept|say goodbye|Apologize/i, text)
  }
})

test("after a decline on PayPal, the agent's goodbye comes before the call ends", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("happy"))
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()
  paypal.cancel(awaiting.state.orderId)
  await errands.declined(id)
  const ended = await until(errands, id, callEnded)
  const texts = ended.transcript.map((line) => line.text)
  const goodbye = texts.findIndex((text) => text.includes("call back later"))
  assert.ok(goodbye >= 0, "the agent says goodbye")
  assert.ok(texts.indexOf("Call ended") > goodbye)
})

test("a simulated shop quotes the menu prices plus tax and itemizes the deal", async () => {
  for (const request of ["2 Sesame bagel, 1 Drip coffee", "2 Sesame bagels and 1 Drip coffee for pickup"]) {
    const { errands } = setup()
    const { id } = await errands.start({ ...order("happy", 900), request })
    const awaiting = await until(errands, id, inState("awaiting_approval"))
    if (awaiting.state.kind !== "awaiting_approval") return assert.fail()
    assert.deepEqual(awaiting.state.deal.items, [
      { name: "Sesame bagel", quantity: 2 },
      { name: "Drip coffee", quantity: 1 },
    ], request)
    assert.equal(awaiting.state.deal.totalCents, 751, request)
    assert.ok(awaiting.transcript.some((line) => line.text === "I'd like to order 2 Sesame bagel, 1 Drip coffee for pickup, please." || line.text === "I'd like to order 2 Sesame bagels and 1 Drip coffee for pickup, please."), request)
  }
})

test("a question carries the moment the shop stops holding", async () => {
  const { errands } = setup()
  const before = Date.now()
  const { id } = await errands.start(order("out_of_stock"))
  const asking = await until(errands, id, inState("asking"))
  if (asking.state.kind !== "asking") return assert.fail()
  const deadline = Date.parse(asking.state.until)
  assert.ok(deadline >= before + 200 && deadline <= Date.now() + 200)
})

const callDeal = { items: [{ name: "bagels", quantity: 12 }], totalCents: 1_600, pickupTime: "in 20 minutes", payeeEmail: "sam@bagels.example" }
const callLines = [
  { speaker: "shop" as const, text: "That's $16.00 with tax.", at: "2026-10-18T10:00:00.000Z" },
  { speaker: "agent" as const, text: "What email is your PayPal under?", at: "2026-10-18T10:00:05.000Z" },
]

test("the receipt hash is stable, 64 hex characters, and moves when one character of the transcript does", () => {
  const shop = { name: "Sam's Bagels", phone: "+15550100" }
  const hash = receiptHash(shop, callDeal, callLines)
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(receiptHash({ ...shop }, { ...callDeal }, callLines.map((line) => ({ ...line }))), hash)
  const edited = [{ ...callLines[0]!, text: "That's $15.00 with tax." }, callLines[1]!]
  assert.notEqual(receiptHash(shop, callDeal, edited), hash)
  assert.notEqual(receiptHash(shop, { ...callDeal, totalCents: 1_601 }, callLines), hash)
})

test("the deal's receipt hash reaches PayPal as the order's custom_id and covers the transcript so far", async () => {
  const { paypal, errands } = setup()
  const { id } = await errands.start(order("happy"))
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()
  const { receipt, orderId, deal } = awaiting.state

  assert.equal(paypal.peek(orderId)!.customId, receipt.hash)
  assert.deepEqual(await paypal.order(orderId), { status: "CREATED", customId: receipt.hash, authorizationId: null, authorizationStatus: null, captureId: null, captureStatus: null })
  assert.equal(receipt.hash, receiptHash(awaiting.input.shop, deal, awaiting.transcript.slice(0, receipt.lines)))
  assert.ok(receipt.lines > 0 && receipt.lines <= awaiting.transcript.length)

  paypal.approve(orderId)
  await errands.approved(id)
  await errands.confirmPickup(id, true)
  const paid = errands.get(id)!.state
  assert.equal(paid.kind === "paid" && paid.receipt.hash, receipt.hash)
})

test("a shop without PayPal still gets a receipt, with no PayPal order", async () => {
  const { errands } = setup()
  const { id } = await errands.start(order("no_paypal"))
  const ended = await until(errands, id, callEnded)
  if (ended.state.kind !== "pay_at_pickup") return assert.fail()
  const view = await errands.receipt(id)
  assert.equal(view?.hash, ended.state.receipt.hash)
  assert.equal(view?.orderId, null)
  assert.equal(view?.payPalCustomId, null)
})

test("an errand with no deal has no receipt", async () => {
  const { errands } = setup()
  const { id } = await errands.start(order("out_of_stock"))
  await until(errands, id, callEnded)
  assert.equal(await errands.receipt(id), undefined)
})

test("an authorized deal writes a Shop Card with the payee, total and receipt hash", async () => {
  const { paypal, errands, cards } = setup()
  const { id } = await errands.start(order("happy"))
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return assert.fail()
  assert.equal(cards.get("sim:happy"), undefined)

  paypal.approve(awaiting.state.orderId)
  await errands.approved(id)
  const card = cards.get("sim:happy")!
  assert.equal(card.name, "Sam's Bagels")
  assert.equal(card.payeeEmail, "orders@samsbagels.example")
  assert.equal(card.lastDeal.totalCents, awaiting.state.deal.totalCents)
  assert.equal(card.receiptHash, awaiting.state.receipt.hash)
  assert.equal(card.calls, 1)

  await errands.confirmPickup(id, true)
  assert.equal(cards.get("sim:happy")!.calls, 1)
})

test("a Shop Card survives reopening the database file", () => {
  const dir = mkdtempSync(join(tmpdir(), "dial-cards-"))
  try {
    const path = join(dir, "cards.db")
    const errand: Errand = {
      id: "e1",
      input: order("happy"),
      state: { kind: "pay_at_pickup", deal: callDeal, receipt: { hash: "abc", lines: 2 } },
      transcript: [],
      version: 0,
      createdAt: "2026-10-18T10:00:00.000Z",
    }
    const first = sqliteCards(path)
    first.record(errand)
    first.close()
    const second = sqliteCards(path)
    const card = second.get("sim:happy")
    second.close()
    assert.equal(card?.payeeEmail, "sam@bagels.example")
    assert.equal(card?.receiptHash, "abc")
    assert.deepEqual(card?.lastDeal, callDeal)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function restartable(run: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "dial-errands-"))
  return run(join(dir, "errands.db")).finally(() => rmSync(dir, { recursive: true, force: true }))
}

async function holdOn(path: string) {
  const store = sqliteErrands(path)
  const first = manual(undefined, undefined, undefined, store)
  const { id } = await first.errands.start(order("happy"))
  await first.agent().onToolCall("propose_deal", agreed)
  const state = first.errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  first.paypal.approve(state.orderId)
  await first.errands.approved(id)
  store.close()
  return { ...first, id }
}

test("an errand survives a restart with its state, captions, pickup key and return secret", () =>
  restartable(async (path) => {
    const first = await holdOn(path)
    const before = first.errands.get(first.id)!
    const secret = new URL(first.paypal.peek("FAKE-ORDER-1")!.returnUrl).searchParams.get("back")!
    const store = sqliteErrands(path)
    const { errands } = manual(first.paypal, first.paypal, undefined, store)
    store.close()
    const after = errands.get(first.id)!
    assert.deepEqual(after.state, before.state)
    assert.deepEqual(after.transcript, before.transcript)
    assert.equal(errands.pickupKey(first.id), first.errands.pickupKey(first.id))
    assert.ok(errands.pickupKey(first.id))
    assert.equal(errands.fromPayPal(first.id, secret), true)
    assert.equal(errands.fromPayPal(first.id, "wrong"), false)
  }))

test("a held payment survives a restart and is collected at pickup", () =>
  restartable(async (path) => {
    const first = await holdOn(path)
    const store = sqliteErrands(path)
    const { errands } = manual(first.paypal, first.paypal, undefined, store)
    await errands.recover()
    assert.equal(errands.get(first.id)!.state.kind, "authorized")
    await errands.confirmPickup(first.id, true)
    store.close()
    assert.equal(errands.get(first.id)!.state.kind, "paid")
  }))

test("after a restart with a fresh PayPal, a held errand fails as unknown to PayPal", () =>
  restartable(async (path) => {
    const first = await holdOn(path)
    const store = sqliteErrands(path)
    const { errands } = manual(undefined, undefined, undefined, store)
    await errands.recover()
    const state = errands.get(first.id)!.state
    assert.equal(state.kind, "failed")
    assert.equal(state.kind === "failed" && state.reason, "paypal_error")
    assert.equal(store.load().find((r) => r.errand.id === first.id)?.errand.state.kind, "failed")
    store.close()
  }))

test("a call open at restart is failed and no money moved", () =>
  restartable(async (path) => {
    const store = sqliteErrands(path)
    const first = manual(undefined, undefined, undefined, store)
    const { id } = await first.errands.start(order("happy"))
    void first.agent().onToolCall("ask_user", { question: "Plain or sesame?" })
    assert.equal(first.errands.get(id)!.state.kind, "asking")
    store.close()
    const reopened = sqliteErrands(path)
    const { errands } = manual(undefined, undefined, undefined, reopened)
    await errands.recover()
    reopened.close()
    const state = errands.get(id)!.state
    assert.equal(state.kind, "failed")
    assert.equal(state.kind === "failed" && state.reason, "call_error")
    assert.match(state.kind === "failed" ? state.detail : "", /No money moved/)
  }))

test("the second errand to a shop is briefed with the email on file, and the card counts both calls", async () => {
  const { paypal, errands, cards, briefs, agent } = manual()
  for (const round of [1, 2]) {
    const { id } = await errands.start(order("happy"))
    await agent().onToolCall("propose_deal", agreed)
    const state = errands.get(id)!.state
    if (state.kind !== "awaiting_approval") return assert.fail()
    paypal.approve(state.orderId)
    await errands.approved(id)
    assert.equal(cards.get("sim:happy")!.calls, round)
  }
  assert.match(briefs[0]!.instructions, /What email is your PayPal account under/)
  assert.doesNotMatch(briefs[0]!.instructions, /on file is/)
  assert.match(briefs[1]!.instructions, /on file is sam@bagels\.example/)
  assert.doesNotMatch(briefs[1]!.instructions, /What email is your PayPal account under/)
})

test("a pay-at-pickup deal writes a card with no payee", async () => {
  const { errands, cards } = setup()
  const { id } = await errands.start(order("no_paypal"))
  await until(errands, id, callEnded)
  const card = cards.get("sim:no_paypal")!
  assert.equal(card.payeeEmail, null)
  assert.equal(card.lastDeal.payeeEmail, null)
  assert.equal(card.calls, 1)
})

test("after a shop took no PayPal, the next brief says so and still asks once", async () => {
  const { errands, briefs, agent } = manual()
  await errands.start(order("no_paypal"))
  await agent().onToolCall("propose_deal", { ...agreed, payee_email: null })
  await errands.start(order("no_paypal"))
  assert.match(briefs[1]!.instructions, /took no PayPal last time/)
  assert.match(briefs[1]!.instructions, /What email is your PayPal account under/)
})

test("a shop that names a new PayPal email after one is on file is blocked, and the card keeps the old one", async () => {
  const { errands, agent, paypal, cards } = manual()
  const first = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(first.id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(first.id)

  const second = await errands.start(order("happy"))
  const reply = await agent().onToolCall("propose_deal", { ...agreed, payee_email: "thief@example.com" })
  assert.match(reply, /^Rejected\..*on file/)
  assert.equal(errands.get(second.id)!.state.kind, "calling")
  assert.ok(errands.get(second.id)!.transcript.some((line) => line.text === "Blocked: The shop gave a different PayPal email than the one on file. Dial said no."))
  assert.equal(cards.get("sim:happy")!.payeeEmail, "sam@bagels.example")
})

test("a capture webhook that arrives while pickup captures joins that step instead of racing it", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const slow = gate()
  const { errands, agent } = manual(paypal, { ...paypal, capture: async (authorizationId) => slow.opened.then(() => paypal.capture(authorizationId)) })
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)
  const held = errands.get(id)!.state
  if (held.kind !== "authorized") throw new Error(held.kind)
  let settled = 0
  errands.watch(id, (errand) => void (errand.state.kind === "paid" && (settled += 1)))
  const capturing = errands.confirmPickup(id, true)
  const reported = errands.reconcile({ kind: "captured", authorizationId: held.authorizationId, captureId: "FROM-WEBHOOK" })
  slow.release()
  await Promise.all([capturing, reported])
  assert.equal(settled, 1)
  const paid = errands.get(id)!.state
  assert.equal(paid.kind, "paid")
  if (paid.kind === "paid") assert.match(paid.captureId, /^FAKE-CAPTURE-/)
})

test("after a restart, a hold PayPal cannot be reached about is kept, not failed", () =>
  restartable(async (path) => {
    const first = await holdOn(path)
    const store = sqliteErrands(path)
    const unreachable = { ...first.paypal, order: async () => Promise.reject(new TypeError("fetch failed")) }
    const { errands } = manual(first.paypal, unreachable, undefined, store)
    await errands.recover()
    store.close()
    assert.equal(errands.get(first.id)!.state.kind, "authorized")
  }))

test("a capture PayPal declines leaves the money held and the errand unpaid", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const { errands, agent } = manual(paypal, { ...paypal, capture: async () => Promise.reject(new Error("PayPal answered the capture with status DECLINED")) })
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)
  await assert.rejects(errands.confirmPickup(id, true), /DECLINED/)
  assert.equal(errands.get(id)!.state.kind, "authorized")
})

test("after a restart, a hold PayPal already captured or voided is recorded as paid or voided", () =>
  restartable(async (path) => {
    const first = await holdOn(path)
    const auth = first.errands.get(first.id)!.state
    if (auth.kind !== "authorized") throw new Error(auth.kind)
    await first.paypal.capture(auth.authorizationId)
    const store = sqliteErrands(path)
    const { errands } = manual(first.paypal, first.paypal, undefined, store)
    await errands.recover()
    store.close()
    const after = errands.get(first.id)!.state
    assert.equal(after.kind, "paid")
    assert.equal(after.kind === "paid" && after.captureId, "FAKE-CAPTURE-1")
  }))

test("a receipt still loads when PayPal cannot be read, and says so", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const { errands, agent } = manual(paypal, { ...paypal, order: async () => Promise.reject(new Error("fetch failed")) })
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const view = await errands.receipt(id)
  assert.equal(view?.payPalCustomId, null)
  assert.equal(view?.payPalError, "fetch failed")
})

async function approvalOn(path: string) {
  const store = sqliteErrands(path)
  const first = manual(undefined, undefined, undefined, store)
  const { id } = await first.errands.start(order("happy"))
  await first.agent().onToolCall("propose_deal", agreed)
  const state = first.errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  first.paypal.approve(state.orderId)
  store.close()
  return { ...first, id, orderId: state.orderId }
}

test("after a restart, an errand left awaiting approval fails, and a hold PayPal already made is voided", () =>
  restartable(async (path) => {
    const lost = await approvalOn(path)
    const store = sqliteErrands(path)
    const { errands } = manual(lost.paypal, lost.paypal, undefined, store)
    await errands.recover()
    const state = errands.get(lost.id)!.state
    assert.equal(state.kind === "failed" && state.reason, "no_deal")
    assert.equal(lost.paypal.peek(lost.orderId)!.authorization, undefined)
    store.close()
  }).then(() =>
    restartable(async (path) => {
      const made = await approvalOn(path)
      await made.paypal.authorize(made.orderId)
      const store = sqliteErrands(path)
      const { errands } = manual(made.paypal, made.paypal, undefined, store)
      await errands.recover()
      assert.equal(errands.get(made.id)!.state.kind, "failed")
      assert.equal(made.paypal.peek(made.orderId)!.authorization!.status, "VOIDED")
      store.close()
    }),
  ))

test("the customer can ask the shop to hold longer twice, and can end the call with no money moved", async () => {
  const { errands, agent } = manual()
  const { id } = await errands.start(order("happy"))
  const question = agent().onToolCall("ask_user", { question: "Plain instead?" })
  assert.equal(errands.wait(id), true)
  assert.equal(errands.wait(id), true)
  assert.equal(errands.wait(id), false)
  const held = errands.get(id)!.state
  assert.equal(held.kind === "asking" && held.waits, 2)

  errands.hangUp(id)
  assert.match(await question, /ended the call/)
  const state = errands.get(id)!.state
  assert.equal(state.kind === "failed" && state.reason, "user_cancelled")
  assert.throws(() => errands.hangUp(id), /no call to end/)
})

test("a capture PayPal leaves pending is not paid until PayPal completes it, and a denied one fails", async () => {
  for (const ending of ["captured", "denied"] as const) {
    const paypal = fakePayPal(PUBLIC_URL)
    const { errands, agent } = manual(paypal, { ...paypal, capture: async (authorizationId) => ({ ...(await paypal.capture(authorizationId)), pending: true }) })
    const { id } = await errands.start(order("happy"))
    await agent().onToolCall("propose_deal", agreed)
    const state = errands.get(id)!.state
    if (state.kind !== "awaiting_approval") throw new Error(state.kind)
    paypal.approve(state.orderId)
    await errands.approved(id)
    await errands.confirmPickup(id, true)
    const paying = errands.get(id)!.state
    assert.equal(paying.kind === "paid" && paying.pending, true)
    assert.equal(isFinished(paying), false)

    const captureId = paying.kind === "paid" ? paying.captureId : ""
    await errands.reconcile(ending === "captured" ? { kind: "captured", authorizationId: "unused", captureId } : { kind: "denied", captureId })
    const after = errands.get(id)!.state
    assert.equal(isFinished(after), true)
    assert.equal(after.kind, ending === "captured" ? "paid" : "failed")
    assert.equal(Boolean(after.kind === "paid" && after.pending), false, ending)
  }
})

test("a call that ends after Dial blocked the deal says why no order was agreed", async () => {
  const { errands, agent } = manual()
  const { id } = await errands.start(order("happy"))
  assert.match(await agent().onToolCall("propose_deal", { ...agreed, total_cents: 50_000 }), /Rejected/)
  agent().onEnded("shop hung up")
  const state = errands.get(id)!.state
  assert.equal(state.kind === "failed" && state.reason, "no_deal")
  assert.match(state.kind === "failed" ? state.detail : "", /^The shop asked for \$500\.00, above your .* limit\. Dial said no\. The call ended with no order\.$/)
})

function recording(approvalTimeoutMs = 60_000) {
  const paypal = fakePayPal(PUBLIC_URL)
  const said: string[] = []
  let handlers: CallHandlers | undefined
  const errands = createErrands({
    paypal,
    placeCall: async (_target, _brief, call) => {
      handlers = call
      return { inform: (note) => void said.push(note), press: (digits) => void said.push(`press ${digits}`), hangup() {} }
    },
    cards: sqliteCards(":memory:"),
    store: sqliteErrands(":memory:"),
    publicUrl: PUBLIC_URL,
    approvalTimeoutMs,
  })
  return { paypal, errands, said, agent: () => handlers! }
}

test("a call nobody answers fails with the reason, and no money moves", async () => {
  const cases = [
    ["busy", "no_answer", /line was busy\. No money moved\./],
    ["no_answer", "no_answer", /did not pick up\. No money moved\./],
    ["voicemail", "no_answer", /voicemail, so Dial hung up without leaving a message/],
    ["failed", "call_error", /did not connect\. No money moved\./],
  ] as const
  for (const [unreached, reason, detail] of cases) {
    const { errands, agent } = manual()
    const { id } = await errands.start(order("happy"))
    agent().onEnded("Twilio status", unreached)
    const state = errands.get(id)!.state
    assert.equal(state.kind === "failed" && state.reason, reason)
    assert.match(state.kind === "failed" ? state.detail : "", detail)
  }
})

test("a shop that hangs up while the customer approves ends the errand, and a late approval moves no money", async () => {
  const { errands, agent, paypal } = manual()
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  agent().onEnded("shop hung up")
  const ended = errands.get(id)!.state
  assert.equal(ended.kind === "failed" && ended.reason, "no_deal")
  assert.match(ended.kind === "failed" ? ended.detail : "", /hung up before you approved/)
  paypal.approve(state.orderId)
  await assert.rejects(errands.approved(id), /not awaiting approval/)
  assert.equal(paypal.peek(state.orderId)!.authorization, undefined)
})

test("a hold authorized after the shop hung up is voided at once", async () => {
  const { errands, agent, paypal } = manual()
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  const approving = errands.approved(id)
  agent().onEnded("shop hung up")
  await approving
  assert.equal(errands.get(id)!.state.kind, "failed")
  assert.equal(paypal.peek(state.orderId)!.authorization!.status, "VOIDED")
})

test("an approval that takes too long ends the call politely, and the deadline is on the errand", async () => {
  const { errands, agent, said } = recording(50)
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const waiting = errands.get(id)!.state
  assert.ok(waiting.kind === "awaiting_approval" && Date.parse(waiting.until) > Date.now())
  await until(errands, id, inState("failed"))
  const state = errands.get(id)!.state
  assert.equal(state.kind === "failed" && state.reason, "user_unavailable")
  assert.match(said.at(-1)!, /did not approve the payment in time/)
})

test("the PayPal email is compared without case, and stored in lower case", async () => {
  const { errands, agent, paypal, cards } = manual()
  for (const email of ["Sam@Bagels.example ", "SAM@bagels.EXAMPLE"]) {
    const { id } = await errands.start(order("happy"))
    assert.match(await agent().onToolCall("propose_deal", { ...agreed, payee_email: email }), /^Accepted/)
    const state = errands.get(id)!.state
    if (state.kind !== "awaiting_approval") throw new Error(state.kind)
    assert.equal(state.deal.payeeEmail, "sam@bagels.example")
    paypal.approve(state.orderId)
    await errands.approved(id)
  }
  assert.equal(cards.get("sim:happy")!.payeeEmail, "sam@bagels.example")
})

test("the agent can press menu keys, and the captions show it", async () => {
  const { errands, agent, said } = recording()
  const { id } = await errands.start(order("happy"))
  assert.match(await agent().onToolCall("press_keys", { digits: "1, 0#" }), /Pressed 10#/)
  assert.equal(said.at(-1), "press 10#")
  assert.equal(errands.get(id)!.transcript.at(-1)!.text, "Dial pressed 10#")
  assert.match(await agent().onToolCall("press_keys", { digits: "one" }), /only the digits/)
  assert.equal(said.length, 1)
})

test("the brief asks the agent to spell back the email and handle menus and hold music", () => {
  const { briefs, errands } = manual()
  return errands.start(order("happy")).then(() => {
    assert.match(briefs[0]!.instructions, /spell it.*read it back letter by letter/s)
    assert.match(briefs[0]!.instructions, /press_keys/)
    assert.match(briefs[0]!.instructions, /hold music/)
    assert.ok(briefs[0]!.tools.some((tool) => tool.name === "press_keys"))
  })
})

function collecting(collectAfterMs: number, paypal: FakePayPal = fakePayPal(PUBLIC_URL), store: ErrandStore = sqliteErrands(":memory:"), api: PayPal = paypal) {
  let handlers: CallHandlers | undefined
  const errands = createErrands({
    paypal: api,
    placeCall: async (_target, _brief, call) => ((handlers = call), { inform() {}, press() {}, hangup() {} }),
    cards: sqliteCards(":memory:"),
    store,
    publicUrl: PUBLIC_URL,
    collectAfterMs,
    collectRetryMs: 20,
    pendingCheckMs: 20,
  })
  async function held() {
    const { id } = await errands.start(order("happy"))
    await handlers!.onToolCall("propose_deal", agreed)
    const state = errands.get(id)!.state
    if (state.kind !== "awaiting_approval") throw new Error(state.kind)
    paypal.approve(state.orderId)
    await errands.approved(id)
    return { id, orderId: state.orderId }
  }
  return { paypal, errands, held }
}

test("a hold nobody pays or releases is collected at the collect-by time, so the shop is paid", async () => {
  const { errands, paypal, held } = collecting(40)
  const { id, orderId } = await held()
  const state = errands.get(id)!.state
  assert.ok(state.kind === "authorized" && Date.parse(state.collectBy) > Date.now())
  const paid = await until(errands, id, inState("paid"))
  assert.equal(paid.state.kind === "paid" && paid.state.unclaimed, true)
  assert.equal(paypal.peek(orderId)!.authorization!.status, "CAPTURED")
})

test("a collection PayPal refuses is tried again, and the customer sees why the shop is not paid yet", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  let refusals = 2
  const flaky = { ...paypal, capture: (id: string) => (refusals-- > 0 ? Promise.reject(new Error("PayPal answered the capture with status DECLINED")) : paypal.capture(id)) }
  const { errands, held } = collecting(20, paypal, sqliteErrands(":memory:"), flaky)
  const { id, orderId } = await held()
  const paid = await until(errands, id, inState("paid"))
  assert.equal(paid.state.kind === "paid" && paid.state.unclaimed, true)
  assert.equal(paypal.peek(orderId)!.authorization!.status, "CAPTURED")
  assert.equal(paid.transcript.filter((line) => line.text.includes("Dial tries again every hour")).length, 1)
})

test("a pending payment is checked with PayPal until it completes or is declined, with no webhook", async () => {
  for (const [status, kind] of [["COMPLETED", "paid"], ["DECLINED", "failed"]] as const) {
    const paypal = fakePayPal(PUBLIC_URL)
    const slow = {
      ...paypal,
      capture: async (id: string) => ({ ...(await paypal.capture(id)), pending: true }),
      order: async (id: string) => ({ ...(await paypal.order(id)), captureStatus: status }),
    }
    const { errands, held } = collecting(20, paypal, sqliteErrands(":memory:"), slow)
    const { id } = await held()
    await until(errands, id, (errand) => errand.state.kind === "paid" && errand.state.pending === true)
    const settled = await until(errands, id, (errand) => errand.state.kind === kind && !(errand.state.kind === "paid" && errand.state.pending))
    assert.equal(settled.state.kind, kind, status)
  }
})

test("a hold the customer pays or releases first is not collected again at the collect-by time", async () => {
  for (const pays of [true, false]) {
    const { errands, paypal, held } = collecting(40)
    const { id, orderId } = await held()
    await errands.confirmPickup(id, pays)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const state = errands.get(id)!.state
    assert.equal(state.kind, pays ? "paid" : "voided")
    assert.ok(!(state.kind === "paid" && state.unclaimed))
    assert.equal(paypal.peek(orderId)!.authorization!.status, pays ? "CAPTURED" : "VOIDED")
  }
})

test("after a restart, a hold past its collect-by time is collected", () =>
  restartable(async (path) => {
    const paypal = fakePayPal(PUBLIC_URL)
    const firstStore = sqliteErrands(path)
    const { id, orderId } = await collecting(60 * 60_000, paypal, firstStore).held()
    firstStore.close()
    const store = sqliteErrands(path)
    const saved = store.load().find((record) => record.errand.id === id)!
    if (saved.errand.state.kind !== "authorized") throw new Error(saved.errand.state.kind)
    saved.errand.state.collectBy = new Date(Date.now() - 1_000).toISOString()
    store.save(saved)
    const { errands } = collecting(60 * 60_000, paypal, store)
    await errands.recover()
    const paid = await until(errands, id, inState("paid"))
    assert.equal(paid.state.kind === "paid" && paid.state.unclaimed, true)
    assert.equal(paypal.peek(orderId)!.authorization!.status, "CAPTURED")
    store.close()
  }))

test("the agent tells the shop to hand over the order once PayPal shows the payment, and reassures a wary shop", async () => {
  const { errands, agent, paypal, said } = recording()
  const { id } = await errands.start(order("happy"))
  await agent().onToolCall("propose_deal", agreed)
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)
  assert.match(said.at(-1)!, /Maria pays at the counter, so hand the order over once PayPal shows the payment\. If Maria does not come within a day, the shop is paid anyway/)
  const { briefs, errands: other } = manual()
  await other.start(order("happy"))
  assert.match(briefs[0]!.instructions, /never ask for a password or a code, and you pay nothing/)
  assert.match(briefs[0]!.instructions, /would rather not give an email, the customer pays at pickup/)
})

const meis = (): ErrandInput => ({ ...order("new_to_paypal"), shop: { name: "Mei's Dumplings", phone: "sim:new_to_paypal" } })

function signing(signupTimeoutMs = 60_000, placeCall: PlaceCall = scriptedCalls(0)) {
  const paypal = fakePayPal(PUBLIC_URL)
  const sms = fakeSms()
  const errands = createErrands({ paypal, placeCall, cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl: PUBLIC_URL, sms, signupTimeoutMs, signupCheckMs: 10 })
  return { paypal, sms, errands }
}

test("a shop with no PayPal signs up during the call, and the payment goes to the account PayPal confirmed", async () => {
  const { paypal, sms, errands } = signing()
  const { id } = await errands.start(meis())
  await until(errands, id, inState("signing_up"))
  const [text] = sms.thread("sim:new_to_paypal")
  assert.ok(text!.body.includes(`${PUBLIC_URL}/fake-paypal/signup/${id}`))
  assert.equal(paypal.finishSignUp(id, "Mei@Dumplings.example"), `${PUBLIC_URL}/paypal/signed-up?errand=${id}`)

  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return
  assert.equal(paypal.peek(awaiting.state.orderId)!.payeeEmail, "mei@dumplings.example")
  assert.ok(awaiting.transcript.some((line) => line.speaker === "system" && line.text === "PayPal confirmed the new account for Mei's Dumplings"))
})

test("after a sign-up, only the account PayPal confirmed can be paid, and no deal is taken while the shop signs up", async () => {
  const said: string[] = []
  let handlers: CallHandlers | undefined
  const { paypal, errands } = signing(60_000, async (_target, _brief, call) => {
    handlers = call
    return { inform: (note) => void said.push(note), press() {}, hangup() {} }
  })
  const { id } = await errands.start(meis())
  const deal = (payee_email: string) => handlers!.onToolCall("propose_deal", { items: [{ name: "dumplings", quantity: 1 }], total_cents: 1_100, pickup_time: "6pm", payee_email })

  assert.match(await handlers!.onToolCall("sign_up_shop", {}), /^Dial texted the shop/)
  assert.match(await deal("mei@dumplings.example"), /Wait until/)
  await errands.checkSignUp(id)
  assert.equal(errands.get(id)!.state.kind, "signing_up")

  paypal.finishSignUp(id, "mei@dumplings.example")
  await errands.checkSignUp(id)
  assert.match(said.at(-1)!, /PayPal confirms the shop's new account, mei@dumplings\.example/)
  assert.match(await deal("thief@example.com"), /Rejected.*on file for this shop is mei@dumplings\.example/)
  assert.match(await deal("mei@dumplings.example"), /^Accepted/)
})

test("a shop that does not finish signing up in time is paid at pickup", async () => {
  const { errands } = signing(30)
  const { id } = await errands.start(meis())
  const done = await until(errands, id, (errand) => isFinished(errand.state))
  assert.equal(done.state.kind, "pay_at_pickup")
  assert.ok(done.transcript.some((line) => line.text === "Mei's Dumplings did not finish the PayPal sign-up in time"))
})

test("a shop that hangs up while signing up ends the errand, and a late sign-up moves no money", async () => {
  const { paypal, errands } = signing()
  const { id } = await errands.start(meis())
  await until(errands, id, inState("signing_up"))
  errands.hangUp(id)
  paypal.finishSignUp(id, "mei@dumplings.example")
  await errands.checkSignUp(id)
  assert.equal(errands.get(id)!.state.kind, "failed")
})

test("without a way to text, the shop is offered pay at pickup instead of a sign-up", async () => {
  const { errands, agent } = recording()
  await errands.start(meis())
  assert.match(await agent().onToolCall("sign_up_shop", {}), /cannot text the shop.*payee_email null/)
})

test("an account PayPal cannot pay yet is not used, and a shop that hangs up while signing up ends the errand", async () => {
  let handlers: CallHandlers | undefined
  const { paypal, errands } = signing(60_000, async (_target, _brief, call) => {
    handlers = call
    return { inform() {}, press() {}, hangup() {} }
  })
  const { id } = await errands.start(meis())
  await handlers!.onToolCall("sign_up_shop", {})
  paypal.signedUpShop = async () => ({ merchantId: "MERCHANT-7", email: "mei@dumplings.example", ready: false })
  await errands.checkSignUp(id)
  assert.equal(errands.get(id)!.state.kind, "signing_up")

  handlers!.onEnded("shop hung up")
  const ended = errands.get(id)!
  assert.equal(ended.state.kind, "failed")
  if (ended.state.kind === "failed") assert.equal(ended.state.reason, "no_deal")
})

test("a shop with a PayPal email on file cannot sign up a new account to replace it", async () => {
  let handlers: CallHandlers | undefined
  const paypal = fakePayPal(PUBLIC_URL)
  const cards = sqliteCards(":memory:")
  const errands = createErrands({
    paypal,
    placeCall: async (_target, _brief, call) => {
      handlers = call
      return { inform() {}, press() {}, hangup() {} }
    },
    cards,
    store: sqliteErrands(":memory:"),
    publicUrl: PUBLIC_URL,
    sms: fakeSms(),
  })
  const first = await errands.start(meis())
  await handlers!.onToolCall("propose_deal", { items: [{ name: "dumplings", quantity: 1 }], total_cents: 1_100, pickup_time: "6pm", payee_email: "mei@dumplings.example" })
  const held = errands.get(first.id)!.state
  if (held.kind !== "awaiting_approval") throw new Error(held.kind)
  paypal.approve(held.orderId)
  await errands.approved(first.id)

  const second = await errands.start(meis())
  assert.match(await handlers!.onToolCall("sign_up_shop", {}), /already has a PayPal email on file: mei@dumplings\.example/)
  assert.equal(errands.get(second.id)!.state.kind, "calling")
  assert.equal(paypal.signup(second.id), undefined)
})

test("the PayPal order for a shop that signed up names the merchant PayPal confirmed", async () => {
  const { paypal, errands } = signing()
  const { id } = await errands.start(meis())
  await until(errands, id, inState("signing_up"))
  paypal.finishSignUp(id, "mei@dumplings.example")
  const awaiting = await until(errands, id, inState("awaiting_approval"))
  if (awaiting.state.kind !== "awaiting_approval") return
  assert.equal(paypal.peek(awaiting.state.orderId)!.payeeMerchantId, `FAKE-MERCHANT-${id.slice(0, 8)}`)
  assert.ok(errands.signedUp(id))
})

test("each retry of a refused collection sends a new PayPal-Request-Id, so PayPal does not replay the refusal", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  const attempts: (number | undefined)[] = []
  const flaky = {
    ...paypal,
    capture: (id: string, attempt?: number) => (attempts.push(attempt), attempts.length < 3 ? Promise.reject(new Error("PayPal 422 UNPROCESSABLE_ENTITY")) : paypal.capture(id, attempt)),
  }
  const { errands, held } = collecting(20, paypal, sqliteErrands(":memory:"), flaky)
  const { id } = await held()
  await until(errands, id, inState("paid"))
  assert.deepEqual(attempts, [1, 2, 3])
})

test("a retry first reads the order back, and records a capture that already went through instead of capturing twice", async () => {
  const paypal = fakePayPal(PUBLIC_URL)
  let captures = 0
  const lostReply = {
    ...paypal,
    capture: async (id: string, attempt?: number) => {
      captures++
      await paypal.capture(id, attempt)
      throw new Error("socket hang up")
    },
  }
  const { errands, held } = collecting(20, paypal, sqliteErrands(":memory:"), lostReply)
  const { id, orderId } = await held()
  const paid = await until(errands, id, inState("paid"))
  assert.equal(captures, 1)
  assert.equal(paid.state.kind === "paid" && paid.state.captureId, paypal.peek(orderId)!.authorization!.captureId)
})
