import assert from "node:assert/strict"
import { test } from "node:test"
import { anthropicTurn, LEDGER_RULE, ledgerAgent, studioOutput, type StudioTurn } from "./ledgerAgent.ts"

const user = (text: string) => ({ kind: "input", type: "message" as const, role: "user" as const, content: [{ type: "text", text }] })

test("a Studio turn becomes one Anthropic request with the read-only rule first", () => {
  const turn: StudioTurn = {
    instructions: "Build dashboards.",
    input: [
      user("Which holds are unclaimed?"),
      { kind: "output", type: "function_call", callId: "c1", name: "execute_query", arguments: '{"q":1}' },
      { kind: "input", type: "function_call_output", callId: "c1", output: "2 rows" },
      { kind: "output", type: "reasoning" },
    ],
    tools: [
      { name: "execute_query", description: "Query", parameters: { type: "object" } },
      { name: "web_search", description: "hosted", parameters: {}, kind: "provided" },
    ],
    toolChoice: "required",
    responseFormat: { type: "text" },
  }
  const body = anthropicTurn(turn, "claude-test")
  assert.ok(body.system.startsWith(LEDGER_RULE))
  assert.match(body.system, /Build dashboards\./)
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "Which holds are unclaimed?" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "execute_query", input: { q: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "2 rows" }] },
  ])
  assert.deepEqual(body.tools, [{ name: "execute_query", description: "Query", input_schema: { type: "object" } }])
  assert.deepEqual(body.tool_choice, { type: "any" })
})

test("a call that carries its own result, a JSON format and a leading assistant line are all handled", () => {
  const body = anthropicTurn(
    {
      input: [
        { type: "message", role: "assistant", content: [{ type: "text", text: "Hi, I read the ledger." }] },
        { type: "function_call", callId: "c2", name: "view_schema", arguments: "", result: "fields" },
      ],
      responseFormat: { type: "json", name: "title", schema: { type: "object" } },
    },
    "m",
  )
  assert.equal(body.messages[0]!.role, "user")
  assert.deepEqual(body.messages.at(-1), { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "fields" }] })
  assert.match(body.system, /Reply with only one JSON object/)
  assert.equal("tool_choice" in body, false)
})

test("Claude's reply becomes Studio output items: one message and one function call per tool use", () => {
  assert.deepEqual(studioOutput([{ type: "text", text: "Two holds." }, { type: "tool_use", id: "t1", name: "add_widget", input: { type: "grid" } }], "r1"), [
    { id: "msg_r1", kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: "Two holds.", annotations: [] }] },
    { id: "fc_t1", kind: "output", type: "function_call", callId: "t1", name: "add_widget", arguments: '{"type":"grid"}', status: "completed" },
  ])
  assert.deepEqual(studioOutput([{ type: "tool_use", id: "t2", name: "x", input: {} }], "r2").length, 1)
})

test("the ledger agent calls the Messages API and reports a failed request", async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  const seen: { url: string; body: any }[] = []
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    seen.push({ url, body: JSON.parse(init.body) })
    return Response.json({ id: "msg_1", model: "claude-test", content: [{ type: "text", text: "Nothing is held." }], stop_reason: "end_turn" })
  }) as unknown as typeof fetch
  const result = await ledgerAgent({ apiKey: "k", model: "claude-test" })({ input: [user("Anything held?")] })
  assert.equal(seen[0]!.url, "https://api.anthropic.com/v1/messages")
  assert.equal(seen[0]!.body.model, "claude-test")
  assert.equal(result.output.length, 1)
  assert.equal(result.incomplete, false)

  globalThis.fetch = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch
  await assert.rejects(ledgerAgent({ apiKey: "k", model: "m" })({ input: [user("x")] }), /Model request failed \(401\): bad key/)
})
