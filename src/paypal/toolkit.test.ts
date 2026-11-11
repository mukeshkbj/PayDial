import assert from "node:assert/strict"
import { test } from "node:test"
import { payPalReadTools, readOnlyTools, READ_TOOLS } from "./toolkit.ts"

test("PayPal's Agent Toolkit, configured read-only, gives Dial four lookup tools and none that move money", () => {
  const tools = payPalReadTools({ clientId: "id", clientSecret: "secret", sandbox: true })
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [...READ_TOOLS].sort())
  for (const tool of tools) assert.doesNotMatch(tool.name, /create|capture|refund|pay|cancel|update|send|delete/)
  const getOrder = tools.find((tool) => tool.name === "get_order")!
  assert.equal(getOrder.parameters.type, "object")
  assert.deepEqual(getOrder.parameters.required, ["id"])
  const disputes = tools.find((tool) => tool.name === "list_disputes")!
  assert.ok(disputes.parameters.properties!.dispute_state!.enum!.includes("UNDER_PAYPAL_REVIEW"))
})

test("a toolkit that offers a money-moving tool is refused", () => {
  const fake = { _def: { typeName: "ZodObject", shape: () => ({}) }, parse: (v: unknown) => v }
  assert.throws(() => readOnlyTools({ get_order: { parameters: fake, execute: async () => ({}) }, create_refund: { parameters: fake, execute: async () => ({}) } }), /not read-only: create_refund/)
})
