import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"
import { scriptedCalls } from "./call/scripted.ts"
import { sqliteCards } from "./cards.ts"
import { sqliteErrands } from "./errandStore.ts"
import { createErrands } from "./errands.ts"
import { createApp } from "./http.ts"
import { fakePayPal } from "./paypal/fake.ts"
import { fixturePlaces } from "./places/places.ts"
import { receiptHash, type ReceiptView } from "./receipt.ts"
import { fakeSms, type SmsMessage } from "./sms/sms.ts"
import { createTexts, sqliteChats } from "./texts.ts"

test("a PayPal return or cancel without this errand's return secret changes nothing", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const { id } = await errands.start({ mode: "order", shop: { name: "Sam's Bagels", phone: "sim:happy" }, request: "2 bagels", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "awaiting_approval") await new Promise((resolve) => setTimeout(resolve, 5))

  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  await app.request(`/paypal/cancel?errand=${id}&token=${state.orderId}`)
  await app.request(`/paypal/cancel?errand=${id}&token=${state.orderId}&back=guess`)
  assert.equal(errands.get(id)!.state.kind, "awaiting_approval")

  paypal.approve(state.orderId)
  await app.request(`/paypal/return?errand=${id}&token=${state.orderId}`)
  assert.equal(errands.get(id)!.state.kind, "awaiting_approval")
})

test("the receipt endpoint returns the covered transcript, the hash PayPal holds and what happened to the money", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const shop = { name: "Sam's Bagels", phone: "sim:happy" }
  const { id } = await errands.start({ mode: "order", shop, request: "2 bagels", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "awaiting_approval") await new Promise((resolve) => setTimeout(resolve, 5))

  const res = await app.request(`/api/errands/${id}/receipt`)
  assert.equal(res.status, 200)
  const view = (await res.json()) as ReceiptView
  assert.equal(view.hash, view.payPalCustomId)
  assert.equal(view.hash, receiptHash(shop, view.deal, view.lines))
  assert.match(view.orderId!, /^FAKE-ORDER-/)
  assert.equal(view.outcome, "awaiting_approval")

  assert.equal((await app.request("/api/errands/nope/receipt")).status, 404)
})

test("the shop endpoints carry the Shop Card, or null when there is none", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const before = (await (await app.request("/api/shops?q=deli")).json()) as { card: unknown }[]
  assert.ok(before.length > 0 && before.every((shop) => shop.card === null))

  const { id } = await errands.start({ mode: "order", shop: { name: "Corner Deli", phone: "sim:no_paypal" }, request: "a BLT", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "pay_at_pickup") await new Promise((resolve) => setTimeout(resolve, 5))

  const list = (await (await app.request("/api/shops?q=deli")).json()) as { id: string; card: { payeeEmail: string | null; calls: number } | null }[]
  assert.equal(list.find((shop) => shop.id === "sim-corner-deli")!.card!.payeeEmail, null)
  const one = (await (await app.request("/api/shops/sim-corner-deli")).json()) as { card: { calls: number } | null }
  assert.equal(one.card!.calls, 1)
  const other = (await (await app.request("/api/shops/sim-sams-bagels")).json()) as { card: unknown }
  assert.equal(other.card, null)
})

test("only the pickup key returned to whoever started the errand can collect or release the hold", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const input = { mode: "order", shop: { name: "Sam's Bagels", phone: "sim:happy" }, request: "2 bagels", maxCents: 2_000, customerName: "Maria" }
  const started = await app.request("/api/errands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })
  const { id, pickupKey } = (await started.json()) as { id: string; pickupKey: string }
  assert.ok(pickupKey)
  assert.equal(((await (await app.request(`/api/errands/${id}`)).json()) as Record<string, unknown>).pickupKey, undefined)
  while (errands.get(id)!.state.kind !== "awaiting_approval") await new Promise((resolve) => setTimeout(resolve, 5))
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  paypal.approve(state.orderId)
  await errands.approved(id)

  const pickup = (body: object) => app.request(`/api/errands/${id}/pickup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  assert.equal((await pickup({ receivedAsAgreed: false })).status, 403)
  assert.equal((await pickup({ receivedAsAgreed: false, key: "guess" })).status, 403)
  assert.equal(errands.get(id)!.state.kind, "authorized")
  assert.equal((await pickup({ receivedAsAgreed: true, key: pickupKey })).status, 200)
  assert.equal(errands.get(id)!.state.kind, "paid")
})

function textApp(twilioAuthToken?: string) {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const places = fixturePlaces()
  const sms = fakeSms()
  const texts = createTexts({ errands, places, sms, chats: sqliteChats(":memory:"), publicUrl })
  return { sms, app: createApp({ errands, places, publicUrl, paypal, fakePayPal: paypal, mcpKeys: [], texts, sms, twilioAuthToken }) }
}

test("the simulator records a text and Dial's reply, in order", async () => {
  const { app } = textApp()
  const post = await app.request("/api/text", { method: "POST", body: JSON.stringify({ phone: "+15551230000", body: "hello" }) })
  assert.equal(post.status, 200)

  const thread = (await (await app.request(`/api/text/${encodeURIComponent("+15551230000")}`)).json()) as SmsMessage[]
  assert.deepEqual(thread.map((message) => [message.direction, message.phone]), [["in", "+15551230000"], ["out", "+15551230000"]])
  assert.equal(thread[0]!.body, "hello")
  assert.match(thread[1]!.body, /first name/)

  assert.deepEqual(await (await app.request("/api/text/%2B15559999999")).json(), [])
})

test("the Twilio route rejects a bad signature and accepts a valid one", async () => {
  const token = "secret-token"
  const { app, sms } = textApp(token)
  const form = { From: "+15551230001", Body: "hello" }
  const send = (signature: string) =>
    app.request("/twilio/sms", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      body: new URLSearchParams(form),
    })
  const signed = createHmac("sha1", token).update(`http://dial.test/twilio/smsBodyhelloFrom+15551230001`).digest("base64")

  assert.equal((await send("")).status, 403)
  assert.equal((await send("AAAA")).status, 403)
  assert.deepEqual(sms.thread(form.From), [])

  const ok = await send(signed)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get("content-type"), "text/xml")
  assert.equal(await ok.text(), "<Response/>")
  assert.match(sms.thread(form.From)[0]!.body, /first name/)
})

test("the PayPal return hands the pickup key to the person who approved, once, and only after a hold exists", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const { id } = await errands.start({ mode: "order", shop: { name: "Sam's Bagels", phone: "sim:happy" }, request: "2 bagels", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "awaiting_approval") await new Promise((resolve) => setTimeout(resolve, 5))
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)

  const early = await app.request(new URL(paypal.peek(state.orderId)!.returnUrl).pathname + new URL(paypal.peek(state.orderId)!.returnUrl).search)
  assert.equal(early.headers.get("location"), `/errand/${id}`)

  const customer = paypal.approve(state.orderId)
  const stranger = await app.request(`/paypal/return?errand=${id}&token=${state.orderId}`)
  assert.equal(stranger.headers.get("location"), `/errand/${id}`)
  assert.equal(errands.get(id)!.state.kind, "awaiting_approval")

  const back = await app.request(customer.slice(publicUrl.length))
  assert.equal(back.headers.get("location"), `/errand/${id}#key=${errands.pickupKey(id)}`)

  const replay = await app.request(customer.slice(publicUrl.length))
  assert.equal(replay.headers.get("location"), `/errand/${id}`)
})

test("without a Twilio auth token there is no Twilio route, so an unsigned text cannot act as a customer", async () => {
  const { app, sms } = textApp()
  const res = await app.request("/twilio/sms", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: "+15551230002", Body: "picked up" }),
  })
  assert.notEqual(res.status, 200)
  assert.deepEqual(sms.thread("+15551230002"), [])
})

test("an errand's event stream ends once the errand is finished", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const within = (body: Promise<string>) => Promise.race([body, new Promise<string>((_, fail) => setTimeout(() => fail(new Error("stream stayed open")), 1_000))])
  const { id } = await errands.start({ mode: "order", shop: { name: "Sam's Bagels", phone: "sim:happy" }, request: "2 bagels", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "awaiting_approval") await new Promise((resolve) => setTimeout(resolve, 5))

  const live = within((await app.request(`/api/errands/${id}/events`)).text())
  await errands.declined(id)
  assert.match(await live, /"kind":"failed"/)

  assert.match(await within((await app.request(`/api/errands/${id}/events`)).text()), /"kind":"failed"/)
})

async function webhooks() {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const signed = { ...paypal, verifyWebhook: async (headers: Record<string, string>) => headers["paypal-transmission-sig"] === "fake-valid" }
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal: signed, fakePayPal: paypal, mcpKeys: [] })
  const { id } = await errands.start({ mode: "order", shop: { name: "Sam's Bagels", phone: "sim:happy" }, request: "2 bagels", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "awaiting_approval") await new Promise((resolve) => setTimeout(resolve, 5))
  const state = errands.get(id)!.state
  if (state.kind !== "awaiting_approval") throw new Error(state.kind)
  const send = (event: object, signature = "fake-valid") =>
    app.request("/paypal/webhook", { method: "POST", headers: { "content-type": "application/json", "paypal-transmission-sig": signature }, body: JSON.stringify(event) })
  const approved = { event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: state.orderId } }
  const hold = async () => {
    paypal.approve(state.orderId)
    assert.equal((await send(approved)).status, 200)
    const held = errands.get(id)!.state
    if (held.kind !== "authorized") throw new Error(held.kind)
    return held.authorizationId
  }
  return { errands, paypal, id, send, approved, hold, orderId: state.orderId }
}

test("a webhook with a bad signature is refused and changes nothing", async () => {
  const { errands, paypal, id, send, approved, orderId } = await webhooks()
  paypal.approve(orderId)
  const res = await send(approved, "forged")
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: "Invalid PayPal webhook signature" })
  assert.equal(errands.get(id)!.state.kind, "awaiting_approval")
})

test("an approval webhook holds the money for a customer who closed the tab before the return page", async () => {
  const { errands, id, hold } = await webhooks()
  await hold()
  assert.equal(errands.get(id)!.state.kind, "authorized")
})

test("a capture webhook records the paid state with PayPal's capture id", async () => {
  const { errands, id, send, hold } = await webhooks()
  const authorizationId = await hold()
  const res = await send({ event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-7", supplementary_data: { related_ids: { authorization_id: authorizationId } } } })
  assert.equal(res.status, 200)
  const state = errands.get(id)!.state
  assert.equal(state.kind, "paid")
  if (state.kind === "paid") assert.equal(state.captureId, "CAP-7")
})

test("a void webhook records the voided state", async () => {
  const { errands, id, send, hold } = await webhooks()
  const authorizationId = await hold()
  const res = await send({ event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: authorizationId } })
  assert.equal(res.status, 200)
  assert.equal(errands.get(id)!.state.kind, "voided")
})

test("a webhook of another type, or for no known errand, is accepted and changes nothing", async () => {
  const { errands, id, send, hold } = await webhooks()
  const authorizationId = await hold()
  assert.equal((await send({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: authorizationId } })).status, 200)
  assert.equal((await send({ event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: "OTHER-AUTH" } })).status, 200)
  assert.equal((await send({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "OTHER-ORDER" } })).status, 200)
  assert.equal(errands.get(id)!.state.kind, "authorized")
})

test("in simulation no webhook signature is valid, so nobody can post a capture for a hold", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const res = await app.request("/paypal/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "paypal-transmission-sig": "fake-valid" },
    body: JSON.stringify({ event_type: "PAYMENT.AUTHORIZATION.VOIDED", resource: { id: "FAKE-AUTH-1" } }),
  })
  assert.equal(res.status, 400)
})

test("a malformed errand gets one plain sentence, an errand above the $500 ceiling is refused, and one address can start at most 20 errands in ten minutes", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl })
  const app = createApp({ errands, paypal, places: fixturePlaces(), publicUrl, fakePayPal: paypal, mcpKeys: [] })
  const start = (maxCents: number, from?: string) =>
    app.request("/api/errands", {
      method: "POST",
      headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": `9.9.9.9, ${from}` } : {}) },
      body: JSON.stringify({ mode: "inquire", shop: { name: "Greens Pharmacy", phone: "sim:inquiry" }, request: "Open today?", customerName: "Maria", ...(maxCents ? { mode: "order", request: "2 bagels", shop: { name: "Sam's Bagels", phone: "sim:happy" }, maxCents } : {}) }),
    })

  const broken = await app.request("/api/errands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "order" }) })
  assert.equal(broken.status, 400)
  assert.equal((await broken.json()).error, "Check these fields: shop, request, maxCents, customerName.")
  const garbled = await app.request("/api/errands", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })
  assert.equal((await garbled.json()).error, "The request body is not valid JSON.")

  const huge = await start(9_000_000_000_000)
  assert.equal(huge.status, 400)
  assert.match((await huge.json()).error, /up to \$500\.00/)

  const statuses: number[] = []
  for (let i = 0; i < 21; i++) statuses.push((await start(0, "1.2.3.4")).status)
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200))
  assert.equal(statuses[20], 429)
  assert.equal((await start(0, "5.6.7.8")).status, 200)
  assert.equal((await start(0)).status, 200)
})

test("the shop signs up on the simulated PayPal page from its text, and coming back to Dial confirms the account", async () => {
  const publicUrl = "http://dial.test"
  const paypal = fakePayPal(publicUrl)
  const sms = fakeSms()
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl, sms, signupCheckMs: 60_000 })
  const app = createApp({ errands, places: fixturePlaces(), publicUrl, paypal, fakePayPal: paypal, mcpKeys: [] })
  const { id } = await errands.start({ mode: "order", shop: { name: "Mei's Dumplings", phone: "sim:new_to_paypal" }, request: "8 pork dumplings", maxCents: 2_000, customerName: "Maria" })
  while (errands.get(id)!.state.kind !== "signing_up") await new Promise((resolve) => setTimeout(resolve, 5))

  const link = sms.thread("sim:new_to_paypal")[0]!.body.match(/http\S+/)![0]
  const page = await app.request(link.replace(publicUrl, ""))
  assert.match(await page.text(), /Sign up <strong>Mei's Dumplings<\/strong>/)
  assert.equal((await app.request(`/paypal/signed-up?errand=${id}`)).status, 200)
  assert.equal(errands.get(id)!.state.kind, "signing_up")

  const back = await app.request(`/fake-paypal/signup/${id}`, { method: "POST", body: new URLSearchParams({ email: "mei@dumplings.example" }) })
  const done = await app.request(back.headers.get("location")!.replace(publicUrl, ""))
  assert.match(await done.text(), /You are on PayPal/)
  assert.notEqual(errands.get(id)!.state.kind, "signing_up")
  assert.equal((await app.request("/fake-paypal/signup/nope")).status, 404)
  assert.match(await (await app.request("/paypal/signed-up?errand=nope")).text(), /no longer tied to a call/)
})
