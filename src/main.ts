import { existsSync } from "node:fs"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { createNodeWebSocket } from "@hono/node-ws"
import type { PlaceCall } from "./call/call.ts"
import { scriptedCalls } from "./call/scripted.ts"
import { anthropicChat, openaiChat } from "./call/models.ts"
import { textCalls } from "./call/text.ts"
import { twilioRealtimeCalls } from "./call/twilio-realtime.ts"
import { sqliteCards } from "./cards.ts"
import { sqliteErrands } from "./errandStore.ts"
import { createErrands } from "./errands.ts"
import { ledgerAgent } from "./ledgerAgent.ts"
import { channel3 } from "./products/channel3.ts"
import { createApp } from "./http.ts"
import { fakePayPal } from "./paypal/fake.ts"
import { restPayPal } from "./paypal/rest.ts"
import { googlePlaces } from "./places/google.ts"
import { fixturePlaces, type Places } from "./places/places.ts"
import { fakeSms } from "./sms/sms.ts"
import { twilioSms } from "./sms/twilio.ts"
import { createTexts, sqliteChats } from "./texts.ts"

const env = process.env
const port = Number(env.PORT ?? 8787)
const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/+$/, "")
const openaiApiKey = env.OPENAI_API_KEY
const textModel = env.OPENAI_MODEL ?? "gpt-5-mini"

function choosePayPal() {
  const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = env
  if (clientId && clientSecret)
    return { paypal: restPayPal({ clientId, clientSecret, baseUrl: env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com", webhookId: env.PAYPAL_WEBHOOK_ID, partnerId: env.PAYPAL_PARTNER_ID }), fake: undefined }
  const fake = fakePayPal(publicUrl)
  return { paypal: fake, fake }
}
const { paypal, fake } = choosePayPal()

const scripted = scriptedCalls(Number(env.DIAL_SIM_STEP_MS ?? 1_200), env.DIAL_SIM_PAYEE)
const textComplete = env.ANTHROPIC_API_KEY
  ? anthropicChat({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5" })
  : openaiApiKey
    ? openaiChat({ apiKey: openaiApiKey, model: textModel })
    : undefined
const text = textComplete ? textCalls({ complete: textComplete }) : undefined
const twilio =
  env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER && openaiApiKey
    ? twilioRealtimeCalls({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        fromNumber: env.TWILIO_FROM_NUMBER,
        publicUrl,
        openaiApiKey,
        model: env.OPENAI_REALTIME_MODEL,
      })
    : undefined
const callAllowlist = (env.DIAL_CALL_ALLOWLIST ?? "").split(",").map((n) => n.trim()).filter(Boolean)

function refuse(reason: string, told: string): never {
  console.error(reason)
  throw new Error(told)
}

const placeCall: PlaceCall = async (target, brief, handlers) => {
  const phone = target.input.shop.phone
  if (phone.startsWith("sim:")) return scripted(target, brief, handlers)
  if (phone === "browser" || phone.startsWith("llm:")) {
    if (!text) return refuse("Text calls need ANTHROPIC_API_KEY or OPENAI_API_KEY.", "This server cannot run a typed shop line yet.")
    return text.placeCall(target, brief, handlers)
  }
  if (!twilio) return refuse("Phone calls need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and OPENAI_API_KEY.", "This server cannot place real phone calls yet. Try one of the simulated shops.")
  if (!callAllowlist.includes(phone)) return refuse(`${phone} is not in DIAL_CALL_ALLOWLIST.`, "Dial is not allowed to call this number from this server.")
  return twilio.placeCall(target, brief, handlers)
}

const simulated = fixturePlaces()
const google = env.GOOGLE_MAPS_API_KEY && openaiApiKey ? googlePlaces({ apiKey: env.GOOGLE_MAPS_API_KEY, openaiApiKey, model: textModel }) : undefined
const places: Places = google
  ? {
      search: async (query, near) => [...(await google.search(query, near)), ...(await simulated.search(query))],
      place: (id) => (id.startsWith("sim-") ? simulated.place(id) : google.place(id)),
      menu: (id) => (id.startsWith("sim-") ? simulated.menu(id) : google.menu(id)),
    }
  : simulated

const mcpKeys = (env.DIAL_MCP_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean)
if (!mcpKeys.length && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${publicUrl}/`)) throw new Error(`Set DIAL_MCP_KEYS before serving Dial at ${publicUrl}. A public /mcp endpoint must not be open.`)

function chooseSms() {
  const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_FROM_NUMBER: fromNumber } = env
  if (accountSid && authToken && fromNumber) return { sms: twilioSms({ accountSid, authToken, fromNumber }), fake: undefined, authToken }
  const fake = fakeSms()
  return { sms: fake, fake, authToken: undefined }
}
const { sms, fake: fakeTexts, authToken: twilioAuthToken } = chooseSms()

const dbPath = env.DIAL_DB ?? "dial.db"
const errands = createErrands({ paypal, placeCall, cards: sqliteCards(dbPath), store: sqliteErrands(dbPath), publicUrl, sms })
await errands.recover()
const texts = createTexts({ errands, places, sms, chats: sqliteChats(dbPath), publicUrl })
const app = createApp({
  errands,
  paypal,
  places,
  publicUrl,
  fakePayPal: fake,
  shopSays: text?.shopSays,
  mcpKeys,
  texts,
  sms: fakeTexts,
  twilioAuthToken,
  products: env.CHANNEL3_API_KEY ? channel3({ apiKey: env.CHANNEL3_API_KEY }) : undefined,
  ledgerTurn: env.ANTHROPIC_API_KEY ? ledgerAgent({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5" }) : undefined,
})

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
if (twilio) {
  app.get(
    "/twilio/media/:errandId",
    upgradeWebSocket((c) => {
      let stream: ReturnType<typeof twilio.acceptMediaStream> | undefined
      return {
        onOpen: (_event, ws) => (stream = twilio.acceptMediaStream(c.req.param("errandId") ?? "", (message) => ws.send(message))),
        onMessage: (event) => stream?.receive(String(event.data)),
        onClose: () => stream?.close(),
      }
    }),
  )
  app.post("/twilio/status/:errandId", async (c) => {
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([name, value]) => [name, String(value)]))
    if (!twilio.acceptStatus(c.req.param("errandId"), form, c.req.header("x-twilio-signature") ?? "")) return c.text("Invalid Twilio signature", 403)
    return c.body(null, 204)
  })
}

if (existsSync("web/dist/index.html")) {
  app.use("/*", serveStatic({ root: "web/dist" }))
  app.get("*", serveStatic({ path: "web/dist/index.html" }))
}

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Dial on ${publicUrl}`)
  console.log(`  PayPal: ${fake ? "simulated" : "sandbox REST"}`)
  console.log(`  Calls: simulated${text ? ", text" : ""}${twilio ? ", Twilio" : ""}`)
  console.log(`  Online products: ${env.CHANNEL3_API_KEY ? "Channel3" : "off"}`)
  console.log(`  Ledger agent: ${env.ANTHROPIC_API_KEY ? "Claude" : "off"}`)
  console.log(`  Places: ${google ? "Google + simulated" : "simulated"}`)
  console.log(`  Texts: ${fakeTexts ? "simulated" : "Twilio"}`)
  console.log(`  MCP: ${publicUrl}/mcp`)
})
injectWebSocket(server)
