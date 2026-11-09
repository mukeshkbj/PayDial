import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { formatUsd, isFinished } from "./domain/errand.ts"
import type { Errands } from "./errands.ts"
import { ledgerRows } from "./ledger.ts"
import type { StudioTurn } from "./ledgerAgent.ts"
import { createMcpServer } from "./mcp.ts"
import type { FakePayPal } from "./paypal/fake.ts"
import type { PayPal } from "./paypal/rest.ts"
import type { Places } from "./places/places.ts"
import { noProducts, type Products } from "./products/channel3.ts"
import type { FakeSms } from "./sms/sms.ts"
import { twilioSignatureValid } from "./sms/twilio.ts"
import type { Texts } from "./texts.ts"

type Deps = {
  errands: Errands
  paypal: PayPal
  places: Places
  publicUrl: string
  fakePayPal?: FakePayPal
  shopSays?: (errandId: string, text: string) => void
  mcpKeys: string[]
  texts?: Texts
  sms?: FakeSms
  twilioAuthToken?: string
  ledgerTurn?: (turn: StudioTurn) => Promise<unknown>
  products?: Products
}

const shopInput = z.object({ name: z.string().min(1), phone: z.string().min(1), address: z.string().optional() })
const errandInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("order"), shop: shopInput, request: z.string().min(1), maxCents: z.number().int().positive(), customerName: z.string().min(1) }),
  z.object({ mode: z.literal("inquire"), shop: shopInput, request: z.string().min(1), customerName: z.string().min(1) }),
])

const payPalEvent = z.union([
  z.object({ event_type: z.literal("CHECKOUT.ORDER.APPROVED"), resource: z.object({ id: z.string() }) }).transform(({ resource }) => ({ kind: "approved" as const, orderId: resource.id })),
  z
    .object({
      event_type: z.literal("PAYMENT.CAPTURE.COMPLETED"),
      resource: z.object({ id: z.string(), supplementary_data: z.object({ related_ids: z.object({ authorization_id: z.string() }) }) }),
    })
    .transform(({ resource }) => ({ kind: "captured" as const, authorizationId: resource.supplementary_data.related_ids.authorization_id, captureId: resource.id })),
  z.object({ event_type: z.literal("PAYMENT.AUTHORIZATION.VOIDED"), resource: z.object({ id: z.string() }) }).transform(({ resource }) => ({ kind: "voided" as const, authorizationId: resource.id })),
  z.object({ event_type: z.literal("PAYMENT.CAPTURE.DENIED"), resource: z.object({ id: z.string() }) }).transform(({ resource }) => ({ kind: "denied" as const, captureId: resource.id })),
])

export function createApp({ errands, paypal, places, publicUrl, fakePayPal, shopSays, mcpKeys, texts, sms, twilioAuthToken, ledgerTurn, products = noProducts }: Deps) {
  const app = new Hono({ strict: false })

  app.onError((error, c) => {
    if (error instanceof z.ZodError) return c.json({ error: `Check these fields: ${[...new Set(error.issues.map((issue) => issue.path.join(".") || "body"))].join(", ")}.` }, 400)
    if (error instanceof SyntaxError) return c.json({ error: "The request body is not valid JSON." }, 400)
    return c.json({ error: error.message }, 400)
  })

  app.get("/api/config", (c) => c.json({ shopLine: Boolean(shopSays), payPal: fakePayPal ? "simulated" : "sandbox" }))

  app.get("/api/shops", async (c) => {
    const shops = await places.search(c.req.query("q") ?? "", c.req.query("near"))
    return c.json(shops.map((shop) => ({ ...shop, card: errands.card(shop.phone) ?? null })))
  })

  app.get("/api/shops/:id", async (c) => {
    const place = await places.place(c.req.param("id"))
    if (!place) return c.json({ error: "No such shop" }, 404)
    return c.json({ place, menu: await places.menu(place.id), card: errands.card(place.phone) ?? null })
  })

  const starts = new Map<string, number[]>()
  const tooMany = (client: string | undefined) => {
    if (!client) return false
    const now = Date.now()
    if (starts.size > 1_000) for (const [key, times] of starts) if (now - times.at(-1)! >= 600_000) starts.delete(key)
    const recent = (starts.get(client) ?? []).filter((at) => now - at < 600_000)
    starts.set(client, [...recent, now])
    return recent.length >= 20
  }

  app.post("/api/errands", async (c) => {
    if (tooMany(c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim()))
      return c.json({ error: "Too many errands from this address. Try again in a few minutes." }, 429)
    const errand = await errands.start(errandInput.parse(await c.req.json()))
    return c.json({ ...errand, pickupKey: errands.pickupKey(errand.id) })
  })

  app.get("/api/errands/:id", (c) => {
    const errand = errands.get(c.req.param("id"))
    return errand ? c.json(errand) : c.json({ error: "No such errand" }, 404)
  })

  app.get("/api/errands/:id/receipt", async (c) => {
    const receipt = await errands.receipt(c.req.param("id"))
    return receipt ? c.json(receipt) : c.json({ error: "No receipt for this errand" }, 404)
  })

  app.get("/api/errands/:id/events", (c) => {
    const id = c.req.param("id")
    const first = errands.get(id)
    if (!first) return c.json({ error: "No such errand" }, 404)
    return streamSSE(c, (stream) =>
      new Promise<void>((done) => {
        const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000)
        const end = () => (clearInterval(ping), stop(), done())
        const send = (errand: typeof first) => void stream.writeSSE({ data: JSON.stringify(errand) }).then(() => isFinished(errand.state) && end())
        const stop = errands.watch(id, send)
        stream.onAbort(end)
        send(errands.get(id) ?? first)
      }),
    )
  })

  app.post("/api/errands/:id/answer", async (c) => {
    const { text } = z.object({ text: z.string().min(1) }).parse(await c.req.json())
    errands.answer(c.req.param("id"), text)
    return c.json({ ok: true })
  })

  app.post("/api/errands/:id/wait", (c) => c.json({ ok: errands.wait(c.req.param("id")) }))

  app.post("/api/errands/:id/hangup", (c) => {
    errands.hangUp(c.req.param("id"))
    return c.json({ ok: true })
  })

  app.post("/api/errands/:id/pickup", async (c) => {
    const id = c.req.param("id")
    const { receivedAsAgreed, key } = z.object({ receivedAsAgreed: z.boolean(), key: z.string().optional() }).parse(await c.req.json())
    if (!key || key !== errands.pickupKey(id)) return c.json({ error: "Only the person who approved on PayPal can confirm pickup, from the page PayPal sent them back to." }, 403)
    await errands.confirmPickup(id, receivedAsAgreed)
    return c.json({ ok: true })
  })

  app.post("/api/errands/:id/shop", async (c) => {
    if (!shopSays) return c.json({ error: "Be-the-shop needs ANTHROPIC_API_KEY or OPENAI_API_KEY on the server." }, 501)
    const { text } = z.object({ text: z.string().min(1) }).parse(await c.req.json())
    shopSays(c.req.param("id"), text)
    return c.json({ ok: true })
  })

  const handedOver = new Set<string>()

  app.get("/paypal/return", async (c) => {
    const id = c.req.query("errand") ?? ""
    if (!errands.fromPayPal(id, c.req.query("back"))) return c.redirect(`/errand/${id}`)
    if (errands.get(id)?.state.kind === "awaiting_approval") await errands.approved(id).catch(() => undefined)
    const handOver = errands.get(id)?.state.kind === "authorized" && !handedOver.has(id)
    if (handOver) handedOver.add(id)
    return c.redirect(`/errand/${id}${handOver ? `#key=${errands.pickupKey(id)}` : ""}`)
  })

  app.get("/paypal/cancel", async (c) => {
    const id = c.req.query("errand") ?? ""
    const waiting = errands.get(id)?.state.kind === "awaiting_approval"
    if (waiting && errands.fromPayPal(id, c.req.query("back"))) await errands.declined(id).catch(() => undefined)
    return c.redirect(`/errand/${id}`)
  })

  app.get("/paypal/signed-up", async (c) => {
    const id = c.req.query("errand") ?? ""
    if (errands.get(id)?.state.kind === "signing_up") await errands.checkSignUp(id).catch(() => undefined)
    const waiting = errands.get(id)?.state.kind === "signing_up"
    return c.html(
      sheet(
        "PayPal sign-up · Dial",
        errands.signedUp(id)
          ? `<h1 class="to"><strong>You are on PayPal.</strong></h1><p class="why">Dial is telling the caller now. Go back to the call to finish the order.</p>`
          : waiting
            ? `<h1 class="to"><strong>PayPal is still checking your account.</strong></h1><p class="why">Confirm your email address from PayPal's message. Dial tells the caller when PayPal says you can take payments.</p>`
            : `<h1 class="to"><strong>This link is no longer tied to a call.</strong></h1><p class="why">Any PayPal account you created is yours to keep. No order from Dial is waiting on it.</p>`,
        Boolean(fakePayPal),
      ),
    )
  })

  app.post("/paypal/webhook", async (c) => {
    const event = await c.req.json()
    if (!(await paypal.verifyWebhook(Object.fromEntries(c.req.raw.headers), event))) return c.json({ error: "Invalid PayPal webhook signature" }, 400)
    const parsed = payPalEvent.safeParse(event)
    if (parsed.success) await errands.reconcile(parsed.data)
    return c.json({ ok: true })
  })

  if (fakePayPal) {
    app.get("/fake-paypal/:orderId", (c) => {
      const order = fakePayPal.peek(c.req.param("orderId"))
      if (!order) return c.text("No such order", 404)
      return c.html(fakeApprovalPage(order.id, order.payeeEmail, formatUsd(order.totalCents), order.description))
    })
    app.get("/fake-paypal/signup/:id", (c) => {
      const id = c.req.param("id")
      const shop = errands.get(id)?.input.shop.name
      if (!shop || !fakePayPal.signup(id)) return c.text("No such sign-up", 404)
      return c.html(fakeSignUpPage(id, shop))
    })
    app.post("/fake-paypal/signup/:id", async (c) => {
      const { email } = z.object({ email: z.string().email() }).parse(await c.req.parseBody())
      return c.redirect(fakePayPal.finishSignUp(c.req.param("id"), email))
    })
    app.post("/fake-paypal/:orderId/approve", (c) => c.redirect(fakePayPal.approve(c.req.param("orderId"))))
    app.post("/fake-paypal/:orderId/cancel", (c) => c.redirect(fakePayPal.cancel(c.req.param("orderId"))))
  }

  if (texts && twilioAuthToken) {
    app.post("/twilio/sms", async (c) => {
      const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([name, value]) => [name, String(value)]))
      const signature = c.req.header("x-twilio-signature") ?? ""
      if (!twilioSignatureValid(twilioAuthToken, `${publicUrl}/twilio/sms`, form, signature))
        return c.text("Invalid Twilio signature", 403)
      const { From, Body } = z.object({ From: z.string().min(1), Body: z.string() }).parse(form)
      await texts.received(From, Body)
      return c.body("<Response/>", 200, { "content-type": "text/xml" })
    })
  }

  if (texts && sms) {
    app.post("/api/text", async (c) => {
      const { phone, body } = z.object({ phone: z.string().min(1), body: z.string() }).parse(await c.req.json())
      sms.received(phone, body)
      await texts.received(phone, body)
      return c.json(sms.thread(phone))
    })
    app.get("/api/text/:phone", (c) => c.json(sms.thread(c.req.param("phone"))))
  }

  app.get("/api/online", async (c) => {
    const query = c.req.query("q") ?? ""
    const online = await products.search(query).catch(() => [])
    return c.json({ source: products.source, online })
  })

  const ledgerOpen = (key: string | undefined) => !mcpKeys.length || mcpKeys.includes(key ?? "")

  app.get("/api/ledger/:key?", (c) => {
    if (!ledgerOpen(c.req.param("key"))) return c.json({ error: "Unknown Dial key" }, 401)
    return c.json({ rows: ledgerRows(errands.list()), agent: Boolean(ledgerTurn), payPal: fakePayPal ? "simulated" : "sandbox" })
  })

  app.post("/api/ledger-turn/:key?", async (c) => {
    if (!ledgerOpen(c.req.param("key"))) return c.json({ error: "Unknown Dial key" }, 401)
    if (!ledgerTurn) return c.json({ error: "The ledger agent needs ANTHROPIC_API_KEY on the server." }, 501)
    const body = await c.req.text()
    if (body.length > 600_000) return c.json({ error: "The conversation is too long for one turn." }, 413)
    const turn = JSON.parse(body) as StudioTurn
    if (!Array.isArray(turn.input)) return c.json({ error: "Check these fields: input." }, 400)
    return c.json(await ledgerTurn(turn))
  })

  app.all("/mcp/:key?", async (c) => {
    if (mcpKeys.length && !mcpKeys.includes(c.req.param("key") ?? "")) return c.json({ error: "Unknown Dial key" }, 401)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await createMcpServer(errands, places, publicUrl, products).connect(transport)
    return transport.handleRequest(c.req.raw)
  })

  return app
}

const escape = (text: string) => text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)

function sheet(title: string, content: string, simulated = true) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<link rel="icon" href="/favicon.svg">
<style>
@font-face{font-family:"Atkinson Hyperlegible Next";src:url(/fonts/hyperlegible-next.woff2) format("woff2");font-weight:200 800;font-display:swap}
:root{--paper:oklch(0.978 0.004 250);--ink:oklch(0.2 0.012 265);--ink-2:oklch(0.39 0.012 265);--sunk:oklch(0.948 0.004 250);--card:#fff;--line:oklch(0.905 0.004 250);--signal:oklch(0.89 0.17 98);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--paper:oklch(0.16 0.006 265);--ink:oklch(0.96 0.004 95);--ink-2:oklch(0.82 0.006 95);--sunk:oklch(0.27 0.008 265);--card:oklch(0.205 0.008 265);--line:oklch(0.3 0.008 265)}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--paper);color:var(--ink);font:17px/1.5 "Atkinson Hyperlegible Next",system-ui,sans-serif;display:grid;grid-template-rows:auto 1fr}
header{display:flex;justify-content:space-between;align-items:center;padding:20px calc(16px + clamp(26px,5vw,72px))}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:800;font-size:22px;letter-spacing:-.02em;color:inherit;text-decoration:none}
.brand svg{width:30px;height:30px}
.pill{padding:6px 12px;border-radius:999px;background:var(--sunk);font-size:13px;font-weight:700}
main{display:grid;place-items:center;padding:24px 18px 64px}
.sheet{width:min(420px,100%);background:var(--card);border-radius:22px;padding:28px;box-shadow:0 0 0 1px oklch(0.2 0.02 265/.06),0 24px 60px -24px oklch(0.2 0.03 265/.35)}
.pp{display:flex;align-items:center;gap:8px;color:#003087;font-weight:800;font-size:20px}
@media (prefers-color-scheme:dark){.pp{color:#6cb6ff}}
.pp svg{width:22px;height:22px}
.note{margin:14px 0 0;padding:10px 12px;border-radius:12px;background:var(--sunk);font-size:14px;color:var(--ink-2)}
.to{margin:24px 0 0;font-size:19px;font-weight:400;color:var(--ink-2)}
.to strong{color:var(--ink)}
.amount{margin:2px 0 0;font-size:48px;font-weight:800;letter-spacing:-.03em;line-height:1.1;font-variant-numeric:tabular-nums}
.items{margin:12px 0 0;padding:12px 0 0;border-top:1px dashed var(--line);color:var(--ink-2)}
.why{margin:20px 0 0;font-size:15px;color:var(--ink-2)}
label{display:grid;gap:6px;margin:24px 0 0;font-size:15px;font-weight:700}
input{min-height:52px;padding:0 16px;border:1px solid var(--line);border-radius:14px;background:var(--paper);color:var(--ink);font:17px "Atkinson Hyperlegible Next",system-ui,sans-serif}
input:focus-visible{outline:3px solid var(--signal);outline-offset:2px}
form{margin:0}
button{width:100%;min-height:52px;border:0;border-radius:999px;font:700 17px "Atkinson Hyperlegible Next",system-ui,sans-serif;cursor:pointer;margin-top:12px}
button:focus-visible,a:focus-visible{outline:3px solid var(--signal);outline-offset:3px}
.pay{background:#0070e0;color:#fff;margin-top:24px}
.pay:hover{background:#005ea6}
.cancel{background:var(--sunk);color:var(--ink)}
@media (max-width:640px){header{padding:16px 18px}.sheet{padding:24px 22px}}
</style></head><body>
<header><a class="brand" href="/" aria-label="Dial, home"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="currentColor"/><g fill="var(--paper)"><circle cx="7.86" cy="20.70" r="2.5"/><circle cx="6.81" cy="14.05" r="2.5"/><circle cx="10.47" cy="8.40" r="2.5"/><circle cx="16.98" cy="6.65" r="2.5"/><circle cx="22.99" cy="9.71" r="2.5"/><circle cx="25.40" cy="16.00" r="2.5"/></g><circle cx="20.68" cy="24.15" r="2.4" fill="#f2d634"/></svg>dial</a>${simulated ? `<span class="pill">Simulation · no real money</span>` : ""}</header>
<main><section class="sheet">${content}</section></main></body></html>`
}

const fakeBrand = `
<p class="pp"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513c-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541c-.195 2.741-2.655 5.483-6.441 5.483H8.714Z"/></svg>Simulated PayPal</p>
`

function fakeApprovalPage(orderId: string, payee: string, amount: string, description: string) {
  const [shop, items = ""] = description.split(/:\s(.*)/s)
  return sheet(
    `Simulated PayPal · ${shop} · Dial`,
    `${fakeBrand}
<p class="note">In a real run, this step is PayPal's own page. Here, Dial stands in for it, and no money moves.</p>
<h1 class="to">Approve a payment to <strong>${escape(shop!)}</strong></h1>
<p class="amount">${escape(amount)}</p>
<p class="items">${escape(items)}<br>Paid to ${escape(payee)}</p>
<p class="why">PayPal holds this amount. You pay it at the counter, or release it if the order is wrong. If you do neither within a day, Dial pays the shop.</p>
<form method="post" action="/fake-paypal/${escape(orderId)}/approve"><button class="pay">Approve ${escape(amount)}</button></form>
<form method="post" action="/fake-paypal/${escape(orderId)}/cancel"><button class="cancel">Cancel and return to Dial</button></form>
`,
  )
}

function fakeSignUpPage(id: string, shop: string) {
  const email = `orders@${shop.normalize("NFD").toLowerCase().replace(/[^a-z]+/g, "")}.example`
  return sheet(
    `Simulated PayPal sign-up · ${shop} · Dial`,
    `${fakeBrand}
<p class="note">In a real run, the shop signs up on PayPal's own pages from the text Dial sent. Here, Dial stands in for PayPal.</p>
<h1 class="to">Sign up <strong>${escape(shop)}</strong> to take PayPal</h1>
<p class="why">A caller is ordering from you through Dial. Once PayPal confirms this account, the caller pays you for the order.</p>
<form method="post" action="/fake-paypal/signup/${escape(id)}">
<label>Business email<input name="email" type="email" value="${escape(email)}" required autocomplete="email"></label>
<button class="pay">Create the PayPal account</button>
</form>`,
  )
}
