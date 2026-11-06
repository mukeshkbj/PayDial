import assert from "node:assert/strict"
import { test } from "node:test"
import { fakePayPal } from "./fake.ts"
import { finishProbe, startProbe } from "./probe.ts"

const quiet = () => {}

async function approvedOrder() {
  const paypal = fakePayPal("http://dial.test")
  const { orderId } = await startProbe(paypal, "shop@example.com", quiet)
  paypal.approve(orderId)
  return { paypal, orderId }
}

test("startProbe creates a one-dollar order to the payee and logs the approve URL", async () => {
  const paypal = fakePayPal("http://dial.test")
  const lines: string[] = []

  const { orderId, approveUrl } = await startProbe(paypal, "shop@example.com", (line) => lines.push(line))

  const order = paypal.peek(orderId)
  assert.equal(order?.totalCents, 100)
  assert.equal(order?.payeeEmail, "shop@example.com")
  assert.equal(order?.customId, "probe")
  assert.ok(lines.some((line) => line.includes(approveUrl)))
  assert.ok(lines.some((line) => line.includes(orderId)))
})

test("finish with capture authorizes, captures and reports CAPTURED", async () => {
  const { paypal, orderId } = await approvedOrder()
  const lines: string[] = []

  const result = await finishProbe(paypal, orderId, "capture", (line) => lines.push(line))

  assert.match(result.captureId ?? "", /^FAKE-CAPTURE-/)
  assert.equal(result.authorizationStatus, "CAPTURED")
  assert.equal(result.orderStatus, "COMPLETED")
  assert.ok(lines.some((line) => line.includes(result.authorizationId)))
  assert.ok(lines.some((line) => line.includes(result.captureId!)))
})

test("finish with void releases the hold and reports VOIDED with no capture", async () => {
  const { paypal, orderId } = await approvedOrder()

  const result = await finishProbe(paypal, orderId, "void", quiet)

  assert.equal(result.captureId, null)
  assert.equal(result.authorizationStatus, "VOIDED")
  assert.equal((await paypal.order(orderId)).captureId, null)
})

test("finish rejects an order the buyer never approved", async () => {
  const paypal = fakePayPal("http://dial.test")
  const { orderId } = await startProbe(paypal, "shop@example.com", quiet)

  await assert.rejects(finishProbe(paypal, orderId, "capture", quiet), /cannot authorize/)
  assert.equal(paypal.peek(orderId)?.authorization, undefined)
})
