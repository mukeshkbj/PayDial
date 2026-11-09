import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { anthropicChat, toAnthropic, type Message } from "./models.ts"

function fakeAnthropic(t: TestContext, reply: unknown) {
  const original = globalThis.fetch
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return reply instanceof Response ? reply : Response.json(reply)
  }) as unknown as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

const call = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } })

test("toAnthropic lifts the leading system prompt and keeps later notes as user text", () => {
  const { system, turns } = toAnthropic([
    { role: "system", content: "You are Dial." },
    { role: "user", content: "Rosa's, how can I help?" },
    { role: "assistant", content: "Two conchas, please." },
    { role: "system", content: "The payment is held." },
  ])
  assert.equal(system, "You are Dial.")
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"])
  assert.match(JSON.stringify(turns[2]), /Note from Dial, not the shop\] The payment is held/)
})

test("toAnthropic turns tool calls into tool_use and merges tool results into one user turn", () => {
  const { turns } = toAnthropic([
    { role: "user", content: "That's $5.44." },
    { role: "assistant", content: null, tool_calls: [call("a", "propose_deal", { total_cents: 544 }), call("b", "ask_user", { question: "ok?" })] },
    { role: "tool", tool_call_id: "a", content: "accepted" },
    { role: "tool", tool_call_id: "b", content: "yes" },
  ])
  assert.deepEqual(turns[1], {
    role: "assistant",
    content: [
      { type: "tool_use", id: "a", name: "propose_deal", input: { total_cents: 544 } },
      { type: "tool_use", id: "b", name: "ask_user", input: { question: "ok?" } },
    ],
  })
  assert.deepEqual(turns[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: "accepted" },
      { type: "tool_result", tool_use_id: "b", content: "yes" },
    ],
  })
})

test("toAnthropic starts with a user turn when the shop speaks first", () => {
  const { turns } = toAnthropic([
    { role: "system", content: "You are the shop." },
    { role: "assistant", content: "Rosa's, how can I help?" },
    { role: "user", content: "Two conchas." },
  ])
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"])
})

test("anthropicChat sends the Messages API shape and maps tool_use back to tool calls", async (t) => {
  const calls = fakeAnthropic(t, {
    content: [
      { type: "text", text: "Let me check that." },
      { type: "tool_use", id: "tu_1", name: "propose_deal", input: { total_cents: 544 } },
    ],
  })
  const complete = anthropicChat({ apiKey: "k", model: "claude-test" })
  const messages: Message[] = [{ role: "system", content: "You are Dial." }, { role: "user", content: "That's $5.44." }]
  const reply = await complete(messages, [{ type: "function", function: { name: "propose_deal", description: "Submit the deal.", parameters: { type: "object", properties: {} } } }])

  assert.equal(calls[0]!.url, "https://api.anthropic.com/v1/messages")
  assert.equal(calls[0]!.headers["x-api-key"], "k")
  assert.equal(calls[0]!.headers["anthropic-version"], "2023-06-01")
  assert.equal(calls[0]!.body.model, "claude-test")
  assert.equal(calls[0]!.body.system, "You are Dial.")
  assert.deepEqual(calls[0]!.body.tools, [{ name: "propose_deal", description: "Submit the deal.", input_schema: { type: "object", properties: {} } }])
  assert.deepEqual(reply, {
    role: "assistant",
    content: "Let me check that.",
    tool_calls: [{ id: "tu_1", type: "function", function: { name: "propose_deal", arguments: '{"total_cents":544}' } }],
  })
})

test("anthropicChat returns null content when Claude only calls a tool", async (t) => {
  fakeAnthropic(t, { content: [{ type: "tool_use", id: "x", name: "end_call", input: {} }] })
  const reply = await anthropicChat({ apiKey: "k", model: "m" })([{ role: "user", content: "bye" }])
  assert.equal(reply.content, null)
  assert.equal(reply.tool_calls?.[0]?.function.name, "end_call")
})

test("anthropicChat reports a failed request", async (t) => {
  fakeAnthropic(t, new Response("overloaded", { status: 529 }))
  await assert.rejects(anthropicChat({ apiKey: "k", model: "m" })([{ role: "user", content: "hi" }]), /Model request failed \(529\): overloaded/)
})
