import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { restPayPal } from "./rest.ts"

type Call = { url: string; method: string; headers: Record<string, string>; body: any }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function fakeFetch(calls: Call[], orderBody: unknown) {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body })
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 })
    return Response.json(orderBody)
  }) as typeof fetch
}

const paypal = restPayPal({ clientId: "id", clientSecret: "secret", baseUrl: "https://pp.test" })

test("createOrder authorizes to the shop's PayPal email and carries the receipt hash as custom_id", async () => {
  const calls: Call[] = []
  fakeFetch(calls, { id: "ORDER-1", links: [{ rel: "payer-action", href: "https://pp.test/approve" }] })

  const created = await paypal.createOrder({
    errandId: "errand-1",
    totalCents: 1_600,
    payeeEmail: "sam@bagels.example",
    description: "Sam's Bagels: 12 bagels",
    returnUrl: "https://dial.test/return",
    cancelUrl: "https://dial.test/cancel",
    customId: "ab".repeat(32),
  })

  assert.deepEqual(created, { orderId: "ORDER-1", approveUrl: "https://pp.test/approve" })
  const post = calls.find((call) => call.url === "https://pp.test/v2/checkout/orders")!
  assert.equal(post.method, "POST")
  assert.equal(post.body.intent, "AUTHORIZE")
  assert.equal(post.body.purchase_units[0].payee.email_address, "sam@bagels.example")
  assert.equal(post.body.purchase_units[0].custom_id, "ab".repeat(32))
  assert.equal(post.headers["PayPal-Request-Id"], "errand-1-create")
})

test("order reads custom_id and any authorization back from the purchase unit", async () => {
  const calls: Call[] = []
  fakeFetch(calls, { id: "ORDER-1", status: "COMPLETED", purchase_units: [{ custom_id: "cd".repeat(32), payments: { authorizations: [{ id: "AUTH-9", status: "CAPTURED" }], captures: [{ id: "CAP-1", status: "PENDING" }] } }] })
  assert.deepEqual(await paypal.order("ORDER-1"), { status: "COMPLETED", customId: "cd".repeat(32), authorizationId: "AUTH-9", authorizationStatus: "CAPTURED", captureId: "CAP-1", captureStatus: "PENDING" })
  const get = calls.find((call) => call.url === "https://pp.test/v2/checkout/orders/ORDER-1")!
  assert.equal(get.method, "GET")
  assert.equal(get.headers.Authorization, "Bearer tok")

  fakeFetch([], { id: "ORDER-2", status: "APPROVED", purchase_units: [{}] })
  assert.deepEqual(await paypal.order("ORDER-2"), { status: "APPROVED", customId: null, authorizationId: null, authorizationStatus: null, captureId: null, captureStatus: null })
})

test("authorize, capture and void post to the documented paths, each with its own request id", async () => {
  const calls: Call[] = []
  fakeFetch(calls, { id: "CAPTURE-3", status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: "AUTH-9", status: "CREATED" }] } }] })

  assert.deepEqual(await paypal.authorize("ORDER-1"), { authorizationId: "AUTH-9" })
  assert.deepEqual(await paypal.capture("AUTH-9"), { captureId: "CAPTURE-3", pending: false })
  await paypal.capture("AUTH-9", 3)
  await paypal.void("AUTH-9")

  const posts = calls.filter((call) => call.method === "POST" && !call.url.endsWith("/token"))
  assert.deepEqual(
    posts.map((call) => [call.url, call.headers["PayPal-Request-Id"], call.body]),
    [
      ["https://pp.test/v2/checkout/orders/ORDER-1/authorize", "ORDER-1-authorize", {}],
      ["https://pp.test/v2/payments/authorizations/AUTH-9/capture", "AUTH-9-capture", { final_capture: true }],
      ["https://pp.test/v2/payments/authorizations/AUTH-9/capture", "AUTH-9-capture-3", { final_capture: true }],
      ["https://pp.test/v2/payments/authorizations/AUTH-9/void", "AUTH-9-void", {}],
    ],
  )
})

test("a PayPal error carries the status and debug id", async () => {
  globalThis.fetch = (async (url: string) =>
    url.endsWith("/token")
      ? Response.json({ access_token: "tok", expires_in: 3600 })
      : Response.json({ name: "UNPROCESSABLE_ENTITY", message: "Authorization is voided", debug_id: "dbg-1" }, { status: 422 })) as typeof fetch
  await assert.rejects(paypal.capture("AUTH-9"), (error: Error) => /422 UNPROCESSABLE_ENTITY.*dbg-1/.test(error.message))
})

const transmission = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  "paypal-transmission-id": "tx-1",
  "paypal-transmission-sig": "sig-1",
  "paypal-transmission-time": "2026-10-18T10:00:00Z",
}
const webhookEvent = { id: "WH-EVT-1", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER-1" } }

test("verifyWebhook posts the transmission and event to PayPal and trusts only SUCCESS", async () => {
  const verifying = restPayPal({ clientId: "id", clientSecret: "secret", baseUrl: "https://pp.test", webhookId: "WH-1" })
  const calls: Call[] = []
  fakeFetch(calls, { verification_status: "SUCCESS" })
  assert.equal(await verifying.verifyWebhook(transmission, webhookEvent), true)
  const post = calls.find((call) => call.url === "https://pp.test/v1/notifications/verify-webhook-signature")!
  assert.equal(post.method, "POST")
  assert.match(post.headers["PayPal-Request-Id"]!, /^tx-1-[0-9a-f]{16}$/)
  assert.deepEqual(post.body, {
    auth_algo: "SHA256withRSA",
    cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
    transmission_id: "tx-1",
    transmission_sig: "sig-1",
    transmission_time: "2026-10-18T10:00:00Z",
    webhook_id: "WH-1",
    webhook_event: webhookEvent,
  })

  const replay: Call[] = []
  fakeFetch(replay, { verification_status: "SUCCESS" })
  await verifying.verifyWebhook(transmission, { ...webhookEvent, resource: { id: "ORDER-2" } })
  assert.notEqual(replay[0]!.headers["PayPal-Request-Id"], post.headers["PayPal-Request-Id"])

  fakeFetch([], { verification_status: "FAILURE" })
  assert.equal(await verifying.verifyWebhook(transmission, webhookEvent), false)
})

test("verifyWebhook without a webhook id fails closed and makes no request", async () => {
  globalThis.fetch = (async () => assert.fail("no request expected")) as typeof fetch
  assert.equal(await paypal.verifyWebhook(transmission, webhookEvent), false)
})

test("a declined capture or a denied hold is an error, not a payment", async () => {
  fakeFetch([], { id: "CAPTURE-4", status: "DECLINED" })
  await assert.rejects(paypal.capture("AUTH-9"), /capture with status DECLINED/)
  fakeFetch([], { id: "CAPTURE-5", status: "PENDING" })
  assert.deepEqual(await paypal.capture("AUTH-9"), { captureId: "CAPTURE-5", pending: true })
  fakeFetch([], { id: "ORDER-3", purchase_units: [{ payments: { authorizations: [{ id: "AUTH-3", status: "DENIED" }] } }] })
  await assert.rejects(paypal.authorize("ORDER-3"), /hold with status DENIED/)
})

test("signUpShop asks PayPal for a seller sign-up link tagged with the errand, and returns PayPal's action_url", async () => {
  const calls: Call[] = []
  fakeFetch(calls, { links: [{ rel: "self", href: "https://pp.test/self" }, { rel: "action_url", href: "https://pp.test/signup" }] })
  await assert.rejects(paypal.signUpShop("errand-1", "https://dial.test/back"), /PAYPAL_PARTNER_ID/)
  assert.equal(calls.length, 0)
  const partner = restPayPal({ clientId: "id", clientSecret: "secret", baseUrl: "https://pp.test", partnerId: "PARTNER" })
  assert.deepEqual(await partner.signUpShop("errand-1", "https://dial.test/paypal/signed-up?errand=errand-1"), { signupUrl: "https://pp.test/signup" })
  const post = calls.find((call) => call.url === "https://pp.test/v2/customer/partner-referrals")!
  assert.equal(post.body.tracking_id, "errand-1")
  assert.deepEqual(post.body.products, ["EXPRESS_CHECKOUT"])
  assert.equal(post.body.partner_config_override.return_url, "https://dial.test/paypal/signed-up?errand=errand-1")
  assert.equal(post.headers["PayPal-Request-Id"], "errand-1-signup")
})

test("signedUpShop is ready only when the shop can take payments, its email is confirmed and it granted Dial third-party consent", async () => {
  const partner = restPayPal({ clientId: "id", clientSecret: "secret", baseUrl: "https://pp.test", partnerId: "PARTNER" })
  const answer = (status: Record<string, unknown>) => {
    const calls: Call[] = []
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: undefined })
      if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 })
      if (url.includes("?tracking_id=")) return Response.json({ merchant_id: "MERCHANT-7", tracking_id: "errand-1" })
      return Response.json(status)
    }) as typeof fetch
    return calls
  }

  const consent = [{ integration_type: "OAUTH_THIRD_PARTY" }]
  const calls = answer({ payments_receivable: true, primary_email_confirmed: true, primary_email: "mei@dumplings.example", oauth_integrations: consent })
  assert.deepEqual(await partner.signedUpShop("errand-1"), { merchantId: "MERCHANT-7", email: "mei@dumplings.example", ready: true })
  assert.deepEqual(
    calls.filter((call) => call.url.includes("/partners/")).map((call) => call.url),
    ["https://pp.test/v1/customer/partners/PARTNER/merchant-integrations?tracking_id=errand-1", "https://pp.test/v1/customer/partners/PARTNER/merchant-integrations/MERCHANT-7"],
  )
  answer({ payments_receivable: true, primary_email_confirmed: false, primary_email: "mei@dumplings.example", oauth_integrations: consent })
  assert.equal((await partner.signedUpShop("errand-1"))!.ready, false)
  answer({ payments_receivable: false, primary_email_confirmed: true, primary_email: "mei@dumplings.example", oauth_integrations: consent })
  assert.equal((await partner.signedUpShop("errand-1"))!.ready, false)
  answer({ payments_receivable: true, primary_email_confirmed: true, primary_email: "mei@dumplings.example", oauth_integrations: [] })
  assert.equal((await partner.signedUpShop("errand-1"))!.ready, false)
})

test("signedUpShop finds no shop before the sign-up is done", async () => {
  const partner = restPayPal({ clientId: "id", clientSecret: "secret", baseUrl: "https://pp.test", partnerId: "PARTNER" })
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 })
    return Response.json({ name: "RESOURCE_NOT_FOUND" }, { status: 404 })
  }) as typeof fetch
  assert.equal(await partner.signedUpShop("errand-1"), null)
  await assert.rejects(paypal.signedUpShop("errand-1"), /PAYPAL_PARTNER_ID/)
})

test("an order for a shop that signed up pays its PayPal merchant ID, not an email", async () => {
  const calls: Call[] = []
  fakeFetch(calls, { id: "ORDER-2", links: [{ rel: "payer-action", href: "https://pp.test/approve" }] })
  await paypal.createOrder({ errandId: "errand-2", totalCents: 1_851, payeeEmail: "mei@dumplings.example", payeeMerchantId: "MERCHANT-7", description: "Mei's Dumplings: 1 plate", returnUrl: "https://dial.test/r", cancelUrl: "https://dial.test/c", customId: "ef".repeat(32) })
  const post = calls.find((call) => call.url === "https://pp.test/v2/checkout/orders")!
  assert.deepEqual(post.body.purchase_units[0].payee, { merchant_id: "MERCHANT-7" })
})

test("a PayPal error names its issue code, and an error page that is not JSON keeps its status", async () => {
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/v1/oauth2/token")) return Response.json({ access_token: "tok", expires_in: 3600 })
    if (url.endsWith("/void")) return new Response("<html>Bad Gateway</html>", { status: 502 })
    return Response.json({ name: "UNPROCESSABLE_ENTITY", message: "failed business validation", details: [{ issue: "PAYEE_NOT_CONSENTED" }] }, { status: 422 })
  }) as typeof fetch
  await assert.rejects(paypal.authorize("ORDER-1"), (error: Error & { status?: number }) => error.status === 422 && /PAYEE_NOT_CONSENTED/.test(error.message))
  await assert.rejects(paypal.void("AUTH-1"), (error: Error & { status?: number }) => error.status === 502 && /Bad Gateway/.test(error.message))
})

test("an order with no approve link fails with a reason", async () => {
  fakeFetch([], { id: "ORDER-1", links: [] })
  await assert.rejects(paypal.createOrder({ errandId: "e", totalCents: 100, payeeEmail: "a@b.example", description: "d", returnUrl: "https://r", cancelUrl: "https://c", customId: "x" }), /approval link/)
})
