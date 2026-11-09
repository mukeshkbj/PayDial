import { noProducts, type Products } from "./products/channel3.ts"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { ShopCard } from "./cards.ts"
import { formatUsd, isFinished, type Errand } from "./domain/errand.ts"
import type { Errands } from "./errands.ts"
import type { Places } from "./places/places.ts"

const MAX_WAIT_SECONDS = 25

export function describeErrand(errand: Errand, publicUrl: string) {
  const { state } = errand
  const base = {
    errand_id: errand.id,
    status: state.kind,
    shop: errand.input.shop.name,
    request: errand.input.request,
    live_view: `${publicUrl}/errand/${errand.id}`,
    transcript: errand.transcript.slice(-12).map((line) => `${line.speaker}: ${line.text}`),
  }
  switch (state.kind) {
    case "calling":
      return { ...base, next_step: "The call is in progress. Call get_errand again with wait_seconds to follow it." }
    case "signing_up":
      return { ...base, signs_up_until: state.until, next_step: "The shop has no PayPal, so Dial texted it a PayPal sign-up link and is holding the line. Call get_errand again with wait_seconds to follow it." }
    case "asking":
      return {
        ...base,
        question: state.question,
        options: state.options,
        holds_until: state.until,
        next_step: `The shop is on hold until ${state.until}. Ask the user this question now and send the reply with answer_errand.`,
      }
    case "awaiting_approval":
      return {
        ...base,
        deal: state.deal,
        total: formatUsd(state.deal.totalCents),
        approve_url: state.approveUrl,
        next_step: `The shop is on hold. Give the user this PayPal link to approve ${formatUsd(state.deal.totalCents)}: ${state.approveUrl}`,
      }
    case "authorized":
      return {
        ...base,
        deal: state.deal,
        total: formatUsd(state.deal.totalCents),
        next_step: `PayPal holds the payment. Pickup: ${state.deal.pickupTime}. You cannot pay or release the hold. After approving, PayPal sent the user back to a pickup link only they hold; they pay there at the counter. If they neither pay nor release it by ${state.collectBy}, Dial pays the shop.`,
      }
    case "paid":
      if (state.pending) return { ...base, deal: state.deal, next_step: "PayPal accepted the capture and is still processing it. The shop is not paid yet. Check again later." }
      if (state.unclaimed) return { ...base, deal: state.deal, next_step: "Done. The user did not pay or release the hold within a day, so Dial paid the shop, as agreed at approval." }
      return { ...base, deal: state.deal, next_step: "Done. The shop was paid on PayPal." }
    case "voided":
      return { ...base, deal: state.deal, next_step: "Done. The PayPal hold was released and the user was not charged." }
    case "pay_at_pickup":
      return { ...base, deal: state.deal, next_step: `Done. The shop has no PayPal. The user pays ${formatUsd(state.deal.totalCents)} at pickup.` }
    case "answered":
      return { ...base, findings: state.findings, next_step: "Done. Tell the user the findings." }
    case "failed":
      return { ...base, failure: state.reason, detail: state.detail, next_step: "The errand failed. Tell the user why." }
  }
}

function cardView(card: ShopCard | undefined) {
  if (!card) return
  const { payeeEmail, lastDeal, verifiedAt, calls } = card
  return { payee_email: payeeEmail, last_total_usd: lastDeal.totalCents / 100, verified_at: verifiedAt, calls }
}

function waitForChange(errands: Errands, errand: Errand, seconds: number): Promise<Errand> {
  if (seconds <= 0 || isFinished(errand.state)) return Promise.resolve(errand)
  const kind = errand.state.kind
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(errand), Math.min(seconds, MAX_WAIT_SECONDS) * 1000)
    const stop = errands.watch(errand.id, (changed) => {
      if (changed.state.kind !== kind && changed.state.kind !== "calling") finish(changed)
    })
    function finish(result: Errand) {
      clearTimeout(timer)
      stop()
      resolve(result)
    }
  })
}

const cardOutput = z.object({ payee_email: z.string().nullable(), last_total_usd: z.number(), verified_at: z.string(), calls: z.number() })

const shopOutput = z.looseObject({ id: z.string(), name: z.string(), phone: z.string(), address: z.string(), agent_ready: z.boolean(), card: cardOutput.optional() })

const errandOutput = {
  errand_id: z.string(),
  status: z.enum(["calling", "signing_up", "asking", "awaiting_approval", "authorized", "paid", "voided", "pay_at_pickup", "answered", "failed"]),
  shop: z.string(),
  request: z.string(),
  live_view: z.string(),
  transcript: z.array(z.string()),
  next_step: z.string(),
  question: z.string().optional(),
  options: z.array(z.string()).optional(),
  holds_until: z.string().optional(),
  signs_up_until: z.string().optional(),
  deal: z.looseObject({ totalCents: z.number(), pickupTime: z.string() }).optional(),
  total: z.string().optional(),
  approve_url: z.string().optional(),
  findings: z.string().optional(),
  failure: z.string().optional(),
  detail: z.string().optional(),
}

export function createMcpServer(errands: Errands, places: Places, publicUrl: string, products: Products = noProducts): McpServer {
  const server = new McpServer({ name: "dial", version: "0.1.0" })

  const reply = (value: object) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  })
  const refuse = (error: string, next_step: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error, next_step }) }], isError: true })

  const describe = (errand: Errand) => reply(describeErrand(errand, publicUrl))
  const unknown = (id: string) => refuse(`No errand ${id}.`, "Use the errand_id that dial_shop returned.")

  server.registerTool(
    "find_shops",
    {
      description:
        "Find local shops by what they sell, with phone numbers Dial can call. When Channel3 is configured, sold_online lists the same item from online retailers with buy links: offer those first if the user is happy to buy online, and call a shop when only a local shop has it.",
      inputSchema: { query: z.string().describe("What the user wants, for example 'bagels'"), near: z.string().optional() },
      outputSchema: { shops: z.array(shopOutput), sold_online: z.array(z.looseObject({ title: z.string(), url: z.string(), domain: z.string() })), online_source: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, near }) => {
      const [shops, online] = await Promise.all([places.search(query, near), products.search(query).catch(() => [])])
      return reply({
        shops: shops.map((shop) => {
          const card = cardView(errands.card(shop.phone))
          return { ...shop, agent_ready: Boolean(card?.payee_email), ...(card && { card }) }
        }),
        sold_online: online,
        online_source: products.source,
      })
    },
  )

  server.registerTool(
    "get_menu",
    {
      description: "Get a shop's menu with prices, when Dial can find one. Use it to build a precise request and a fair budget.",
      inputSchema: { shop_id: z.string() },
      outputSchema: { menu: z.unknown(), card: cardOutput.nullable() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ shop_id }) => {
      const place = await places.place(shop_id)
      return reply({ menu: await places.menu(shop_id), card: (place && cardView(errands.card(place.phone))) ?? null })
    },
  )

  server.registerTool(
    "dial_shop",
    {
      description:
        "Phone a local shop for the user. mode 'order' places a pickup order and pays through PayPal only after the user approves the exact total. mode 'inquire' only asks a question, such as price or stock. Returns at once; follow the call with get_errand.",
      inputSchema: {
        shop_name: z.string(),
        shop_phone: z.string().describe("The phone value from find_shops: an E.164 number, or a sim: value for a simulated shop"),
        request: z.string().describe("What to order or ask, in plain words"),
        mode: z.enum(["order", "inquire"]),
        max_usd: z.number().positive().optional().describe("Required for orders: the most the user allows, including tax, up to 500"),
        customer_name: z.string().describe("The user's first name, said on the call"),
      },
      outputSchema: errandOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ shop_name, shop_phone, request, mode, max_usd, customer_name }) => {
      const shop = { name: shop_name, phone: shop_phone }
      if (mode === "order" && max_usd === undefined) return refuse("max_usd is required for orders.", "Ask the user for a budget, then call dial_shop again.")
      const input = mode === "order" ? { mode, shop, request, customerName: customer_name, maxCents: Math.round(max_usd! * 100) } : { mode, shop, request, customerName: customer_name }
      return errands.start(input).then(describe, (error: Error) => refuse(error.message, "Tell the user, and ask what to change."))
    },
  )

  server.registerTool(
    "get_errand",
    {
      description: "Get the state of a call. Set wait_seconds to wait up to 25 seconds for the next step, such as a question or a payment approval.",
      inputSchema: { errand_id: z.string(), wait_seconds: z.number().min(0).max(MAX_WAIT_SECONDS).optional() },
      outputSchema: errandOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ errand_id, wait_seconds = 0 }) => {
      const errand = errands.get(errand_id)
      if (!errand) return unknown(errand_id)
      return describe(await waitForChange(errands, errand, wait_seconds))
    },
  )

  server.registerTool(
    "answer_errand",
    {
      description: "Send the user's answer to the question the shop asked during the call.",
      inputSchema: { errand_id: z.string(), answer: z.string() },
      outputSchema: errandOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ errand_id, answer }) => {
      const errand = errands.get(errand_id)
      if (!errand) return unknown(errand_id)
      if (errand.state.kind !== "asking") return refuse("The shop has no open question.", "Call get_errand to see the current step.")
      errands.answer(errand_id, answer)
      return describe(errands.get(errand_id)!)
    },
  )

  return server
}
