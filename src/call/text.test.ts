import assert from "node:assert/strict"
import { mock, test, type TestContext } from "node:test"
import type { ErrandInput } from "../domain/errand.ts"
import type { Brief, CallHandlers } from "./call.ts"
import { textCalls } from "./text.ts"

type Body = {
  model: string
  messages: { role: string; content: string | null; tool_call_id?: string }[]
  tools?: { type: string; function: { name: string } }[]
}

const brief: Brief = {
  instructions: "You are Dial.",
  tools: [
    { name: "propose_deal", description: "Submit the deal.", parameters: { type: "object", properties: {} } },
    { name: "end_call", description: "Hang up.", parameters: { type: "object", properties: {} } },
  ],
}

const text = (content: string) => ({ role: "assistant", content })
const toolCall = (id: string, name: string, args: unknown) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
})

function fakeModel(t: TestContext, respond: (body: Body, count: number) => unknown) {
  const original = globalThis.fetch
  const requests: Body[] = []
  const urls: string[] = []
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    urls.push(url)
    requests.push(JSON.parse(init.body))
    const reply = respond(requests.at(-1)!, requests.length)
    return reply instanceof Response ? reply : Response.json({ choices: [{ message: reply }] })
  }) as unknown as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })
  return { requests, urls }
}

function recorder(onToolCall: CallHandlers["onToolCall"] = async () => "ok") {
  const lines: string[] = []
  const ended: string[] = []
  const handlers: CallHandlers = {
    onLine: (speaker, line) => void lines.push(`${speaker}: ${line}`),
    onToolCall,
    onEnded: (detail) => void ended.push(detail),
  }
  return { lines, ended, handlers }
}

function target(phone: string) {
  const input: ErrandInput = {
    mode: "order",
    shop: { name: "Sam's Bagels", phone },
    request: "a dozen sesame bagels",
    maxCents: 2_000,
    customerName: "Maria",
  }
  return { errandId: "e1", input }
}

async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(done(), "condition not reached in time")
}

const config = { openaiApiKey: "sk-test", model: "test-model" }

test("human shop: a typed line becomes a shop line and triggers an agent reply", async (t) => {
  const { requests, urls } = fakeModel(t, () => text("Hi, this is an AI assistant calling for Maria."))
  const { placeCall, shopSays } = textCalls(config)
  const { lines, handlers } = recorder()
  const call = await placeCall(target("browser"), brief, handlers)

  shopSays("e1", "Sam's Bagels, hello?")
  await until(() => lines.length === 2)

  assert.deepEqual(lines, ["shop: Sam's Bagels, hello?", "agent: Hi, this is an AI assistant calling for Maria."])
  assert.equal(urls[0], "https://api.openai.com/v1/chat/completions")
  assert.equal(requests[0]!.model, "test-model")
  assert.deepEqual(requests[0]!.messages, [
    { role: "system", content: "You are Dial." },
    { role: "user", content: "Sam's Bagels, hello?" },
  ])
  assert.deepEqual(
    requests[0]!.tools!.map((tool) => [tool.type, tool.function.name]),
    [
      ["function", "propose_deal"],
      ["function", "end_call"],
    ],
  )
  call.hangup()
})

test("tool calls round trip: parsed args out, tool result back in with the matching id", async (t) => {
  const args = { items: [{ name: "bagels", quantity: 12 }], total_cents: 1_500, pickup_time: "8am", payee_email: null }
  const { requests } = fakeModel(t, (_body, count) => (count === 1 ? toolCall("call_1", "propose_deal", args) : text("Thanks, one moment.")))
  const { placeCall, shopSays } = textCalls(config)
  const seen: [string, unknown][] = []
  const { lines, handlers } = recorder(async (name, toolArgs) => {
    seen.push([name, toolArgs])
    return "Accepted. Tell the shop."
  })
  const call = await placeCall(target("browser"), brief, handlers)

  shopSays("e1", "That's $15.")
  await until(() => lines.includes("agent: Thanks, one moment."))

  assert.deepEqual(seen, [["propose_deal", args]])
  assert.equal(requests.length, 2)
  const followUp = requests[1]!.messages
  assert.deepEqual(followUp.at(-1), { role: "tool", tool_call_id: "call_1", content: "Accepted. Tell the shop." })
  assert.equal(followUp.at(-2)!.role, "assistant")
  call.hangup()
})

test("a failing tool call is reported back to the model instead of ending the call", async (t) => {
  const { requests } = fakeModel(t, (_body, count) => (count === 1 ? toolCall("call_1", "propose_deal", {}) : text("Sorry, one second.")))
  const { placeCall, shopSays } = textCalls(config)
  const { lines, ended, handlers } = recorder(async () => {
    throw new Error("bad args")
  })
  const call = await placeCall(target("browser"), brief, handlers)

  shopSays("e1", "hello")
  await until(() => lines.includes("agent: Sorry, one second."))

  assert.equal(requests[1]!.messages.at(-1)!.content, "Tool error: bad args")
  assert.deepEqual(ended, [])
  call.hangup()
})

test("inform adds a system message and produces an agent turn", async (t) => {
  const { requests } = fakeModel(t, (_body, count) => text(count === 1 ? "Hello!" : "The payment is guaranteed."))
  const { placeCall, shopSays } = textCalls(config)
  const { lines, handlers } = recorder()
  const call = await placeCall(target("browser"), brief, handlers)

  shopSays("e1", "hi")
  await until(() => lines.length === 2)
  call.inform("Payment authorized: $15.00.")
  await until(() => lines.length === 3)

  assert.equal(lines[2], "agent: The payment is guaranteed.")
  assert.deepEqual(requests[1]!.messages.at(-1), { role: "system", content: "Payment authorized: $15.00." })
  call.hangup()
})

test("end_call and hangup end the call once, and later shop lines are ignored", async (t) => {
  const { requests } = fakeModel(t, (_body, count) => (count === 1 ? toolCall("call_1", "end_call", { reason: "done" }) : text("unexpected")))
  const { placeCall, shopSays } = textCalls(config)
  let hangup = () => {}
  const { lines, ended, handlers } = recorder(async (name) => {
    if (name === "end_call") hangup()
    return "Call ended."
  })
  const call = await placeCall(target("browser"), brief, handlers)
  hangup = call.hangup

  shopSays("e1", "bye then")
  await until(() => ended.length === 1)
  call.hangup()
  shopSays("e1", "hello? are you there?")
  call.inform("late note")
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(ended, ["agent hung up"])
  assert.deepEqual(lines, ["shop: bye then"])
  assert.equal(requests.length, 1)
})

test("a human shop that stays silent for five minutes ends the call", async (t) => {
  fakeModel(t, () => text("unused"))
  mock.timers.enable({ apis: ["setTimeout"] })
  t.after(() => mock.timers.reset())
  const { placeCall } = textCalls(config)
  const { ended, handlers } = recorder()
  await placeCall(target("browser"), brief, handlers)

  mock.timers.tick(5 * 60_000 - 1)
  assert.deepEqual(ended, [])
  mock.timers.tick(1)
  assert.deepEqual(ended, ["shop stopped responding"])
})

test("llm shop speaks first and answers the agent in character", async (t) => {
  let agentTurns = 0
  const { requests } = fakeModel(t, (body) => {
    if (!body.tools) return text("Sure, that's fifteen dollars.")
    return ++agentTurns === 1 ? text("I'd like a dozen sesame bagels.") : toolCall("call_9", "end_call", { reason: "done" })
  })
  const { placeCall } = textCalls(config)
  let hangup = () => {}
  const { lines, ended, handlers } = recorder(async () => {
    hangup()
    return "Call ended."
  })
  const call = await placeCall(target("llm:A grumpy baker who always has sesame bagels."), brief, handlers)
  hangup = call.hangup

  await until(() => ended.length === 1)

  assert.deepEqual(lines, [
    "shop: Sam's Bagels, how can I help?",
    "agent: I'd like a dozen sesame bagels.",
    "shop: Sure, that's fifteen dollars.",
  ])
  const shopRequest = requests.find((body) => !body.tools)!
  assert.match(shopRequest.messages[0]!.content!, /answering the phone at Sam's Bagels/)
  assert.match(shopRequest.messages[0]!.content!, /A grumpy baker who always has sesame bagels\./)
  assert.deepEqual(shopRequest.messages.slice(1), [
    { role: "assistant", content: "Sam's Bagels, how can I help?" },
    { role: "user", content: "I'd like a dozen sesame bagels." },
  ])
})

test("llm shop conversations stop at the turn cap", async (t) => {
  const { requests } = fakeModel(t, () => text("ok"))
  const { placeCall } = textCalls(config)
  const { ended, handlers } = recorder()
  await placeCall(target("llm:A baker."), brief, handlers)

  await until(() => ended.length === 1)

  assert.match(ended[0]!, /turn limit/)
  assert.equal(requests.length, 40)
})

test("an unknown phone value throws", async () => {
  const { placeCall } = textCalls(config)
  await assert.rejects(placeCall(target("sim:happy"), brief, recorder().handlers), /Unknown text shop "sim:happy"/)
})

test("model errors end the call with the error message", async (t) => {
  fakeModel(t, () => new Response("rate limited", { status: 429 }))
  const { placeCall, shopSays } = textCalls(config)
  const { ended, handlers } = recorder()
  await placeCall(target("browser"), brief, handlers)

  shopSays("e1", "hello")
  await until(() => ended.length === 1)

  assert.match(ended[0]!, /429.*rate limited/)
})
