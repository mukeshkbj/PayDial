import assert from "node:assert/strict"
import { test } from "node:test"
import type { PlaceCall } from "./call/call.ts"
import { scriptedCalls } from "./call/scripted.ts"
import { sqliteCards } from "./cards.ts"
import { sqliteErrands } from "./errandStore.ts"
import { createErrands } from "./errands.ts"
import { fakePayPal } from "./paypal/fake.ts"
import { fixturePlaces } from "./places/places.ts"
import { fakeSms } from "./sms/sms.ts"
import { createTexts, sqliteChats } from "./texts.ts"

const PUBLIC_URL = "http://dial.test"
const SAMS = "2 Sesame bagels and 1 Drip coffee from Sam's Bagels under $10"
const ROSAS = "2 Concha from Rosa's Panadería under $10"

function setup(placeCall: PlaceCall = scriptedCalls(0)) {
  const paypal = fakePayPal(PUBLIC_URL)
  const real = createErrands({ paypal, placeCall, cards: sqliteCards(":memory:"), store: sqliteErrands(":memory:"), publicUrl: PUBLIC_URL })
  const started: string[] = []
  const errands: typeof real = {
    ...real,
    async start(input) {
      const errand = await real.start(input)
      started.push(errand.id)
      return errand
    },
  }
  const sms = fakeSms()
  const chats = sqliteChats(":memory:")
  const restart = () => createTexts({ errands, places: fixturePlaces(), sms, chats, publicUrl: PUBLIC_URL })
  const texts = restart()
  const sent = (phone: string) => {
    const bodies = sms.thread(phone).filter((message) => message.direction === "out").map((message) => message.body)
    for (const body of bodies) assert.ok(body.length < 320, `reply is ${body.length} characters: ${body}`)
    return bodies
  }
  const said = (phone: string, text: string) => sent(phone).find((body) => body.includes(text))
  async function eventually<T>(find: () => T | undefined, what: string): Promise<T> {
    for (let i = 0; i < 300; i++) {
      const found = find()
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Never saw ${what}`)
  }
  return { paypal, errands, texts, restart, started, sent, said, eventually }
}

async function signUp(texts: ReturnType<typeof setup>["texts"], phone: string) {
  await texts.received(phone, "hello")
  await texts.received(phone, "Maria")
}

test("a new number is asked for a first name, then told how to order", async () => {
  const { texts, sent } = setup()
  await texts.received("+15550001", "hello")
  assert.match(sent("+15550001")[0]!, /first name/)
  await texts.received("+15550001", "Maria Lopez")
  assert.equal(sent("+15550001").length, 2)
  assert.match(sent("+15550001")[1]!, /Thanks, Maria\..*2 Sesame bagels and 1 Drip coffee from Sam's Bagels under \$10/)
})

test("an order text starts a call and Dial texts the total with the approval link", async () => {
  const { texts, errands, started, said, eventually } = setup()
  const phone = "+15550002"
  await signUp(texts, phone)
  await texts.received(phone, SAMS)
  await texts.received(phone, "yes")

  const approval = await eventually(() => said(phone, "/fake-paypal/"), "the approval link")
  assert.match(approval, /\$7\.51/)
  assert.match(approval, /http:\/\/dial\.test\/fake-paypal\/FAKE-ORDER-\d+/)
  assert.ok(said(phone, `Dial is calling Sam's Bagels now. Read the call as it happens: http://dial.test/errand/${started[0]}`))
  const { input } = errands.get(started[0]!)!
  assert.deepEqual([input.customerName, input.request, input.mode === "order" && input.maxCents], ["Maria", "2 Sesame bagels and 1 Drip coffee", 1_000])
})

test("the example in the how-to reply is a request Dial accepts", async () => {
  const { texts, sent, said, eventually } = setup()
  const phone = "+15550003"
  await signUp(texts, phone)
  const example = /like this: (.+)$/.exec(sent(phone)[1]!)![1]!
  await texts.received(phone, example)
  await texts.received(phone, "yes")
  await eventually(() => said(phone, "/fake-paypal/"), "the approval link")
})

test("a question text lists numbered options and a reply of 1 answers it", async () => {
  const { texts, errands, started, said, eventually } = setup()
  const phone = "+15550004"
  await signUp(texts, phone)
  await texts.received(phone, ROSAS)
  await texts.received(phone, "yes")

  const question = await eventually(() => said(phone, "Is the plain version okay?"), "the question")
  assert.match(question, /1\. Yes, plain is fine/)
  assert.match(question, /2\. No, skip it/)
  assert.match(question, /Rosa's Panadería is holding\. Reply within \d+ seconds, with a number or your own words\./)

  await texts.received(phone, "1")
  await eventually(() => said(phone, "/fake-paypal/"), "the approval link")
  const { state } = errands.get(started[0]!)!
  assert.equal(state.kind, "awaiting_approval")
  if (state.kind === "awaiting_approval") assert.deepEqual(state.deal.items, [{ name: "Concha, plain", quantity: 2 }])
})

test("words that are not a number answer the question as typed", async () => {
  const { texts, errands, started, said, eventually } = setup()
  const phone = "+15550005"
  await signUp(texts, phone)
  await texts.received(phone, ROSAS)
  await texts.received(phone, "yes")
  await eventually(() => said(phone, "Is the plain version okay?"), "the question")

  await texts.received(phone, "No thanks")
  await eventually(() => said(phone, "could not finish"), "the failure text")
  assert.equal(errands.get(started[0]!)!.state.kind, "failed")
})

async function authorize(env: ReturnType<typeof setup>, phone: string) {
  await signUp(env.texts, phone)
  await env.texts.received(phone, SAMS)
  await env.texts.received(phone, "yes")
  const approval = await env.eventually(() => env.said(phone, "/fake-paypal/"), "the approval link")
  env.paypal.approve(/(FAKE-ORDER-\d+)/.exec(approval)![1]!)
  await env.errands.approved(env.started[0]!)
  await env.eventually(() => env.said(phone, "PayPal is holding"), "the hold text")
}

test("PAY at the counter captures the payment and Dial texts that it is paid; PICKED UP still works", async () => {
  for (const [phone, reply] of [["+15550006", "Pay"], ["+15550016", "picked up"]] as const) {
    const env = setup()
    await authorize(env, phone)
    assert.match(env.said(phone, "PayPal is holding")!, /\$7\.51.*in 20 minutes.*At the counter, reply PAY.*PROBLEM.*within a day, Dial pays the shop/)

    await env.texts.received(phone, reply)
    assert.equal(env.errands.get(env.started[0]!)!.state.kind, "paid")
    assert.match(env.said(phone, "Paid.")!, /\$7\.51 to Sam's Bagels/)
  }
})

test("PROBLEM after authorization releases the hold", async () => {
  const env = setup()
  const phone = "+15550007"
  await authorize(env, phone)

  await env.texts.received(phone, "Problem")
  assert.equal(env.errands.get(env.started[0]!)!.state.kind, "voided")
  assert.match(env.said(phone, "released the hold")!, /not charged/)
})

test("any other text after authorization leaves the payment held", async () => {
  const env = setup()
  const phone = "+15550008"
  await authorize(env, phone)

  await env.texts.received(phone, "what now?")
  assert.equal(env.errands.get(env.started[0]!)!.state.kind, "authorized")
  assert.ok(env.said(phone, "At the counter, reply PAY"))
})

test("a request Dial cannot parse gets the example back and starts no errand", async () => {
  const { texts, started, sent } = setup()
  const phone = "+15550009"
  await signUp(texts, phone)
  await texts.received(phone, "some bagels please")
  await texts.received(phone, "what is this")

  const replies = sent(phone).slice(2)
  assert.equal(replies.length, 2)
  for (const reply of replies) assert.match(reply, /2 Sesame bagels and 1 Drip coffee from Sam's Bagels under \$10/)
  assert.deepEqual(started, [])
})

test("a shop Dial cannot find gets a reply and starts no errand", async () => {
  const { texts, started, sent } = setup()
  const phone = "+15550010"
  await signUp(texts, phone)
  await texts.received(phone, "2 bagels from Zzyzx Qwerty under $10")

  assert.match(sent(phone).at(-1)!, /could not find a shop called "Zzyzx Qwerty"/)
  assert.deepEqual(started, [])
})

test("two phone numbers hold separate conversations", async () => {
  const { texts, sent } = setup()
  await texts.received("+15550011", "hello")
  await texts.received("+15550012", "hello")
  await texts.received("+15550011", "Ana")
  assert.equal(sent("+15550011").length, 2)
  assert.equal(sent("+15550012").length, 1)
})

test("an order in the very first text is kept, and starts once Dial has a name", async () => {
  const { texts, started, sent, said, eventually } = setup()
  const phone = "+15550013"
  await texts.received(phone, ROSAS)
  assert.match(sent(phone)[0]!, /I have your order\. What is your first name\?/)
  assert.deepEqual(started, [])

  await texts.received(phone, "Ana")
  await texts.received(phone, "yes")
  await eventually(() => said(phone, "Is the plain version okay?"), "the question")
  assert.equal(started.length, 1)
})

test("everyday phrasing with number words reads as an order", async () => {
  const { texts, errands, started, eventually } = setup()
  const phone = "+15550014"
  await signUp(texts, phone)
  await texts.received(phone, "can I get two conchas from rosa under ten dollars please")
  await texts.received(phone, "yes")

  await eventually(() => started[0], "an errand")
  const { input } = errands.get(started[0]!)!
  assert.deepEqual([input.shop.name, input.request, input.mode === "order" && input.maxCents], ["Rosa's Panadería", "2 conchas", 1_000])
})

test("STOP silences Dial until START, and HELP explains how to order", async () => {
  const { texts, sent } = setup()
  const phone = "+15550015"
  await signUp(texts, phone)
  await texts.received(phone, "STOP")
  assert.match(sent(phone).at(-1)!, /no more texts.*START/)
  const count = sent(phone).length

  await texts.received(phone, SAMS)
  await texts.received(phone, "help")
  assert.equal(sent(phone).length, count)

  await texts.received(phone, "start")
  assert.match(sent(phone).at(-1)!, /Welcome back/)
  await texts.received(phone, "HELP")
  assert.match(sent(phone).at(-1)!, /PayPal.*like this: 2 Sesame bagels.*STOP/)
})

test("a name given as a sentence is read as the name", async () => {
  const { texts, sent } = setup()
  for (const [phone, reply] of [["+15550016", "I'm Maria"], ["+15550017", "my name is Maria."], ["+15550018", "Hi, this is Maria"]] as const) {
    await texts.received(phone, "hello")
    await texts.received(phone, reply)
    assert.match(sent(phone)[1]!, /^Thanks, Maria\./)
  }
})

test("the approval text names the items and the pickup time", async () => {
  const { texts, said, eventually } = setup()
  const phone = "+15550019"
  await signUp(texts, phone)
  await texts.received(phone, SAMS)
  await texts.received(phone, "yes")
  const approval = await eventually(() => said(phone, "/fake-paypal/"), "the approval link")
  assert.match(approval, /Sam's Bagels agreed \$7\.51 for .*Sesame bagel.*, ready in 20 minutes\. You pay at the counter. If you do not pay or release the hold within a day, Dial pays the shop. Approve it on PayPal:/)
})

test("STOP during a hold says what PayPal still holds and how to settle it", async () => {
  const env = setup()
  const phone = "+15550020"
  await authorize(env, phone)
  await env.texts.received(phone, "STOP")
  assert.match(env.sent(phone).at(-1)!, /no more texts.*PayPal still holds \$7\.51\. Text START, then PAY or PROBLEM/)
})

test("a text limit above the ceiling gets a reply and starts no errand", async () => {
  const { texts, started, sent } = setup()
  const phone = "+15550021"
  await signUp(texts, phone)
  await texts.received(phone, "2 bagels from Sam's Bagels under $900")
  assert.match(sent(phone).at(-1)!, /up to \$500\.00 at a time/)
  assert.deepEqual(started, [])
})

test("other ways to say the shop and the limit read as the same order", async () => {
  const { texts, errands, started, eventually } = setup()
  const phrasings = [
    "2 conchas at Rosa's, budget $10",
    "can I get two conchas from rosa, I have 10 dollars",
    "2 conchas for $10 from Rosa's",
    "2 conchas from Rosa's max ten bucks",
  ]
  for (const [i, text] of phrasings.entries()) {
    const phone = `+1555003${i}`
    await signUp(texts, phone)
    await texts.received(phone, text)
    await texts.received(phone, "yes")
    await eventually(() => started[i], `an errand for "${text}"`)
    const { input } = errands.get(started[i]!)!
    assert.deepEqual([input.shop.name, input.request, input.mode === "order" && input.maxCents], ["Rosa's Panadería", "2 conchas", 1_000], text)
  }
})

test("an order missing one part gets one question, and the reply completes it", async () => {
  const { texts, errands, started, sent, eventually } = setup()
  const phone = "+15550040"
  await signUp(texts, phone)

  await texts.received(phone, "2 conchas from Rosa's")
  assert.equal(sent(phone).at(-1), "What is the most you want to spend on 2 conchas?")
  await texts.received(phone, "10")
  await texts.received(phone, "yes")
  await eventually(() => started[0], "an errand")
  const { input } = errands.get(started[0]!)!
  assert.equal(input.mode === "order" && input.maxCents, 1_000)

  const other = "+15550041"
  await signUp(texts, other)
  await texts.received(other, "2 conchas under $10")
  assert.equal(sent(other).at(-1), "Which shop should I order 2 conchas from?")
  await texts.received(other, "Moonbase Tacos")
  assert.match(sent(other).at(-1)!, /could not find a shop called "Moonbase Tacos"\. Which shop/)
  await texts.received(other, "at Rosa's")
  await texts.received(other, "yes")
  await eventually(() => started[1], "a second errand")
  assert.equal(errands.get(started[1]!)!.input.shop.name, "Rosa's Panadería")
})

test("a chat survives a restart, and \"got it\" does not count as picked up", async () => {
  const env = setup()
  const phone = "+15550042"
  await authorize(env, phone)

  const texts = env.restart()
  await texts.received(phone, "got it")
  assert.equal(env.errands.get(env.started[0]!)!.state.kind, "authorized")
  assert.match(env.sent(phone).at(-1)!, /reply PAY/)

  await texts.received(phone, "I picked it up!")
  assert.equal(env.errands.get(env.started[0]!)!.state.kind, "paid")
})

test("an order sent after hello is kept while Dial asks for the name", async () => {
  const { texts, errands, started, sent, eventually } = setup()
  const phone = "+15550050"
  await texts.received(phone, "hi")
  await texts.received(phone, "2 conchas from Rosa's Panaderia under $8")
  assert.equal(sent(phone).at(-1), "I have your order. What is your first name?")
  await texts.received(phone, "Is that needed?")
  assert.equal(sent(phone).at(-1), "What is your first name?")
  assert.deepEqual(started, [])

  await texts.received(phone, "Ana")
  await texts.received(phone, "yes")
  await eventually(() => started[0], "an errand")
  const { input } = errands.get(started[0]!)!
  assert.deepEqual([input.customerName, input.shop.name, input.mode === "order" && input.maxCents], ["Ana", "Rosa's Panadería", 800])
})

test("short and spoken phrasings of the shop and the limit read as an order", async () => {
  const { texts, errands, started, eventually } = setup()
  const phrasings = ["pls order 2 conchas @ rosa's, I can spend up to ten dollars"]
  for (const [i, text] of phrasings.entries()) {
    const phone = `+1555006${i}`
    await signUp(texts, phone)
    await texts.received(phone, text)
    await texts.received(phone, "yes")
    await eventually(() => started[i], `an errand for "${text}"`)
    const { input } = errands.get(started[i]!)!
    assert.deepEqual([input.shop.name, input.request, input.mode === "order" && input.maxCents], ["Rosa's Panadería", "2 conchas", 1_000], text)
  }
})

test("an order Dial cannot read is not echoed back", async () => {
  const { texts, sent } = setup()
  const phone = "+15550002222"
  await signUp(texts, phone)
  await texts.received(phone, "quiero 2 conchas de Rosa por $10")
  assert.equal(sent(phone).at(-1), "Which shop should I call? Dial reads orders in English, like this: 2 Sesame bagels and 1 Drip coffee from Sam's Bagels under $10")
})

test("a text during the call gets the shop's last words and the captions link", async () => {
  const { texts, started, said, eventually } = setup(async (_target, _brief, call) => {
    call.onLine("shop", "Sam's Bagels, how can I help?")
    return { inform() {}, press() {}, hangup() {} }
  })
  const phone = "+15550001111"
  await signUp(texts, phone)
  await texts.received(phone, SAMS)
  await texts.received(phone, "yes")
  await eventually(() => said(phone, "Dial is calling"), "the call")
  await texts.received(phone, "what did they say?")
  assert.ok(said(phone, `Sam's Bagels last said: "Sam's Bagels, how can I help?" Read the whole call: http://dial.test/errand/${started[0]}`))
})

test("WAIT asks the shop to hold longer, and HANG UP ends the call with no money moved", async () => {
  const { texts, errands, started, sent, said, eventually } = setup()
  const phone = "+15550070"
  await signUp(texts, phone)
  await texts.received(phone, ROSAS)
  await texts.received(phone, "yes")
  assert.match(await eventually(() => said(phone, "Is the plain version okay?"), "the question"), /Text WAIT for more time\./)

  await texts.received(phone, "wait")
  assert.equal(sent(phone).at(-1), "Dial asked Rosa's Panadería to hold longer. Reply when you are ready.")
  await eventually(() => errands.get(started[0]!)!.transcript.find((line) => line.text === "Sure, take your time."), "the shop agreeing to hold")
  assert.equal(errands.get(started[0]!)!.state.kind, "asking")
  await texts.received(phone, "hang up")
  await eventually(() => said(phone, "You ended the call to Rosa's Panadería. No money moved."), "the hang-up text")
  const { state } = errands.get(started[0]!)!
  assert.equal(state.kind === "failed" && state.reason, "user_cancelled")
})

test("a text while PayPal waits resends the link, and after a call ends RETRY calls again", async () => {
  const { texts, started, sent, said, eventually } = setup()
  const phone = "+15550080"
  await signUp(texts, phone)
  await texts.received(phone, SAMS)
  await texts.received(phone, "yes")
  await eventually(() => said(phone, "/fake-paypal/"), "the approval link")
  await texts.received(phone, "what now")
  assert.match(sent(phone).at(-1)!, /^Sam's Bagels is holding while you approve \$7\.51 on PayPal: .*\/fake-paypal\//)

  const other = "+15550081"
  await signUp(texts, other)
  await texts.received(other, ROSAS)
  await texts.received(other, "yes")
  await eventually(() => said(other, "Is the plain version okay?"), "the question")
  await texts.received(other, "hang up")
  await eventually(() => said(other, "You ended the call to Rosa's Panadería. No money moved. Text RETRY to call again."), "the hang-up text")
  await texts.received(other, "ok")
  assert.equal(sent(other).at(-1), "The call to Rosa's Panadería has ended. Text RETRY to call again, or text a new order.")
  await texts.received(other, "retry")
  await eventually(() => started[2], "a second call to Rosa's")
})

test("Dial reads the order back and calls only on YES", async () => {
  const { texts, started, sent } = setup()
  const phone = "+15550090"
  await signUp(texts, phone)
  await texts.received(phone, "2 conchas at Rosa's under $10")
  assert.equal(sent(phone).at(-1), "I will call Rosa's Panadería to order 2 conchas, up to $10.00. Reply YES to call, or text the order again.")
  assert.deepEqual(started, [])
  await texts.received(phone, "no")
  assert.equal(sent(phone).at(-1), "Okay, Dial will not call. Text the order again when you are ready.")
  assert.deepEqual(started, [])
})

test("informal orders, a shop named first, and a note before the ask read as an order", async () => {
  const { texts, errands, started, eventually } = setup()
  const cases = [
    ["can u get me 2 bagels from sams bagels, 10 max", "Sam's Bagels", "2 bagels", 1_000],
    ["Sam's Bagels: 2 sesame bagels, max $10", "Sam's Bagels", "2 sesame bagels", 1_000],
    ["im deaf can u order me a pizza from Tony's Pizza under $30", "Tony's Pizza", "a pizza", 3_000],
  ] as const
  for (const [i, [text, shop, request, maxCents]] of cases.entries()) {
    const phone = `+1555009${i + 1}`
    await signUp(texts, phone)
    await texts.received(phone, text)
    await texts.received(phone, "yes")
    await eventually(() => started[i], `an errand for "${text}"`)
    const { input } = errands.get(started[i]!)!
    assert.deepEqual([input.shop.name, input.request, input.mode === "order" && input.maxCents], [shop, request, maxCents], text)
  }
})

test("Dial calls only the shop the customer named, leaves a disclosure out of the order, and never takes YES as a name", async () => {
  const { texts, errands, started, sent, eventually } = setup()
  const unknown = "+15550100"
  await signUp(texts, unknown)
  await texts.received(unknown, "order 2 bagels from Joe's Deli under $10")
  assert.equal(sent(unknown).at(-1), `I could not find a shop called "Joe's Deli". Which shop should I call?`)

  const noisy = "+15550101"
  await signUp(texts, noisy)
  await texts.received(noisy, "Order 2 conchas and 1 oreja from Rosa's, I can pay $8")
  assert.match(sent(noisy).at(-1)!, /^I will call Rosa's Panadería to order 2 conchas and 1 oreja, up to \$8\.00\./)

  const deaf = "+15550102"
  await signUp(texts, deaf)
  await texts.received(deaf, "I'm deaf, please order 2 sesame bagels from Sam's Bagels, max $10")
  await texts.received(deaf, "yes")
  await eventually(() => started[0], "an errand")
  assert.equal(errands.get(started[0]!)!.input.request, "2 sesame bagels")

  const yes = "+15550103"
  await texts.received(yes, "hello")
  await texts.received(yes, "YES")
  assert.equal(sent(yes).at(-1), "What is your first name?")
})
