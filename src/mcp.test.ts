import assert from "node:assert/strict"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { scriptedCalls } from "./call/scripted.ts"
import { sqliteCards } from "./cards.ts"
import { sqliteErrands } from "./errandStore.ts"
import { createErrands } from "./errands.ts"
import { createMcpServer } from "./mcp.ts"
import { fakePayPal } from "./paypal/fake.ts"
import { fixturePlaces } from "./places/places.ts"
import { fakeSms } from "./sms/sms.ts"

async function connect() {
  const paypal = fakePayPal("http://dial.test")
  const cards = sqliteCards(":memory:")
  const errands = createErrands({ paypal, placeCall: scriptedCalls(0), cards, store: sqliteErrands(":memory:"), publicUrl: "http://dial.test", sms: fakeSms(), signupCheckMs: 10 })
  const server = createMcpServer(errands, fixturePlaces(), "http://dial.test")
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test-host", version: "1.0.0" })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    assert.notEqual(result.isError, true, JSON.stringify(result.content))
    return result.structuredContent as Record<string, any>
  }
  return { client, call, paypal, errands, cards }
}

test("an MCP host can find a shop, order and get approval, but only the customer can release the money", async () => {
  const { client, call, paypal, errands } = await connect()
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["answer_errand", "dial_shop", "find_shops", "get_errand", "get_menu"])
  const hint = (name: string) => tools.find((tool) => tool.name === name)!.annotations
  for (const name of ["find_shops", "get_menu", "get_errand"]) assert.equal(hint(name)?.readOnlyHint, true, name)
  assert.equal(hint("dial_shop")?.openWorldHint, true)

  const { shops } = await call("find_shops", { query: "bagels" })
  const sams = shops.find((shop: { name: string }) => shop.name === "Sam's Bagels")
  const { menu } = await call("get_menu", { shop_id: sams.id })
  assert.ok(menu.sections.length > 0)

  const started = await call("dial_shop", {
    shop_name: sams.name,
    shop_phone: sams.phone,
    request: "a dozen bagels",
    mode: "order",
    max_usd: 25,
    customer_name: "Maria",
  })
  const awaiting = await call("get_errand", { errand_id: started.errand_id, wait_seconds: 5 })
  assert.equal(awaiting.status, "awaiting_approval")
  assert.equal(awaiting.total, "$20.00")
  assert.match(awaiting.approve_url, /fake-paypal\/FAKE-ORDER-1/)

  paypal.approve("FAKE-ORDER-1")
  await errands.approved(started.errand_id)
  const authorized = await call("get_errand", { errand_id: started.errand_id })
  assert.equal(authorized.status, "authorized")

  assert.match(authorized.next_step, /cannot pay or release the hold.*Dial pays the shop/)
  for (const result of [started, awaiting, authorized]) assert.ok(!JSON.stringify(result).includes(errands.pickupKey(started.errand_id)!), "no MCP result carries the pickup key")
})

test("an order without a budget is refused before any call", async () => {
  const { client } = await connect()
  const result = await client.callTool({
    name: "dial_shop",
    arguments: { shop_name: "Sam's Bagels", shop_phone: "sim:happy", request: "bagels", mode: "order", customer_name: "Maria" },
  })
  assert.equal(result.isError, true)
})

test("a mid-call question reaches the host and the answer resumes the call", async () => {
  const { call } = await connect()
  const started = await call("dial_shop", {
    shop_name: "Rosa's Panadería",
    shop_phone: "sim:out_of_stock",
    request: "six conchas",
    mode: "order",
    max_usd: 20,
    customer_name: "Maria",
  })
  const asking = await call("get_errand", { errand_id: started.errand_id, wait_seconds: 5 })
  assert.equal(asking.status, "asking")
  assert.deepEqual(asking.options, ["Yes, plain is fine", "No, skip it"])

  await call("answer_errand", { errand_id: started.errand_id, answer: "Yes, plain is fine" })
  const awaiting = await call("get_errand", { errand_id: started.errand_id, wait_seconds: 5 })
  assert.equal(awaiting.status, "awaiting_approval")
})

test("a host following a shop that signs up for PayPal sees the sign-up, then the approval link", async () => {
  const { call, paypal } = await connect()
  const started = await call("dial_shop", {
    shop_name: "Mei's Dumplings",
    shop_phone: "sim:new_to_paypal",
    request: "a plate of Pork and chive dumplings",
    mode: "order",
    max_usd: 30,
    customer_name: "Maya",
  })
  const signing = await call("get_errand", { errand_id: started.errand_id, wait_seconds: 5 })
  assert.equal(signing.status, "signing_up")
  assert.match(signing.next_step, /sign-up link/)

  paypal.finishSignUp(started.errand_id, "mei@dumplings.example")
  const awaiting = await call("get_errand", { errand_id: started.errand_id, wait_seconds: 5 })
  assert.equal(awaiting.status, "awaiting_approval")
  assert.equal(awaiting.deal.payeeEmail, "mei@dumplings.example")
})

test("find_shops and get_menu show the Shop Card once a shop has agreed a deal", async () => {
  const { call, paypal, errands } = await connect()
  const before = await call("find_shops", { query: "" })
  assert.ok(before.shops.length > 1)
  assert.ok(before.shops.every((shop: { agent_ready: boolean }) => !shop.agent_ready))
  assert.equal((await call("get_menu", { shop_id: "sim-sams-bagels" })).card, null)

  const started = await call("dial_shop", {
    shop_name: "Sam's Bagels",
    shop_phone: "sim:happy",
    request: "a dozen bagels",
    mode: "order",
    max_usd: 25,
    customer_name: "Maria",
  })
  await call("get_errand", { errand_id: started.errand_id, wait_seconds: 5 })
  paypal.approve("FAKE-ORDER-1")
  await errands.approved(started.errand_id)

  const after = await call("find_shops", { query: "" })
  const ready = after.shops.filter((shop: { agent_ready: boolean }) => shop.agent_ready)
  assert.deepEqual(ready.map((shop: { name: string }) => shop.name), ["Sam's Bagels"])
  assert.equal(ready[0].card.payee_email, "orders@samsbagels.example")
  assert.equal(ready[0].card.last_total_usd, 20)
  assert.equal(ready[0].card.calls, 1)
  assert.ok(ready[0].card.verified_at)
  assert.deepEqual((await call("get_menu", { shop_id: "sim-sams-bagels" })).card, ready[0].card)
})

test("a shop that takes no PayPal keeps a card but is not agent-ready", async () => {
  const { call, errands } = await connect()
  const started = await call("dial_shop", {
    shop_name: "Corner Deli",
    shop_phone: "sim:no_paypal",
    request: "1 Turkey club",
    mode: "order",
    max_usd: 20,
    customer_name: "Maria",
  })
  while (errands.get(started.errand_id)!.state.kind !== "pay_at_pickup") await new Promise((resolve) => setTimeout(resolve, 5))
  const { shops } = await call("find_shops", { query: "deli" })
  const deli = shops.find((shop: { name: string }) => shop.name === "Corner Deli")
  assert.equal(deli.card.payee_email, null)
  assert.equal(deli.agent_ready, false)
})

test("every tool declares its output and reach, and a refusal says what to do next", async () => {
  const { client } = await connect()
  const { tools } = await client.listTools()
  for (const tool of tools) {
    assert.ok(tool.outputSchema, `${tool.name} has no output schema`)
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", `${tool.name} has no openWorldHint`)
  }

  const refusals = [
    ["dial_shop", { shop_name: "Sam's Bagels", shop_phone: "sim:happy", request: "bagels", mode: "order", max_usd: 900, customer_name: "Maria" }],
    ["get_errand", { errand_id: "nope" }],
    ["answer_errand", { errand_id: "nope", answer: "yes" }],
  ] as const
  for (const [name, args] of refusals) {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, true, name)
    const { error, next_step } = JSON.parse((result.content as { text: string }[])[0]!.text)
    assert.ok(error && next_step, `${name} refusal: ${error}`)
  }
})

test("a host can ask every plumber at once and compare the answers, and plumbers stay out of the browse list", async () => {
  const { call } = await connect()
  const { shops } = await call("find_shops", { query: "plumber" })
  assert.equal(shops.length, 6)

  const findings = await Promise.all(
    shops.map(async (shop: { name: string; phone: string }) => {
      const started = await call("dial_shop", {
        shop_name: shop.name,
        shop_phone: shop.phone,
        request: "Can you come tomorrow to fix a leaking pipe, and what is your call-out fee?",
        mode: "inquire",
        customer_name: "Maya",
      })
      const done = await call("get_errand", { errand_id: started.errand_id, wait_seconds: 5 })
      assert.equal(done.status, "answered")
      return { name: shop.name, findings: done.findings as string }
    }),
  )
  const fee = (text: string) => Number(/\$(\d+)/.exec(text)?.[1] ?? Infinity)
  const tomorrow = findings.filter((f) => f.findings.includes("tomorrow") && fee(f.findings) < Infinity)
  const cheapest = tomorrow.sort((a, b) => fee(a.findings) - fee(b.findings))[0]
  assert.equal(tomorrow.length, 4)
  assert.equal(cheapest?.name, "Rivera Plumbing")

  const browse = await fixturePlaces().search("")
  assert.equal(browse.length, 6)
  assert.ok(browse.every((shop) => !shop.name.includes("Plumb")))
})
