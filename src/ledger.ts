import type { Errand } from "./domain/errand.ts"

export type LedgerRow = {
  errand: string
  created: string
  day: string
  shop: string
  customer: string
  outcome: string
  money: string
  limit: number | null
  agreed: number | null
  held: number
  paid: number
  released: number
  blockedAsk: number | null
  gateBlocks: number
  payPalOrder: string | null
  authorization: string | null
  capture: string | null
  receiptHash: string | null
  receiptOnOrder: "in custom_id" | "no PayPal order"
}

const OUTCOME: Record<Errand["state"]["kind"], string> = {
  calling: "On the call",
  signing_up: "Shop signing up",
  asking: "Asking the customer",
  awaiting_approval: "Awaiting PayPal approval",
  authorized: "Held on PayPal",
  paid: "Paid to the shop",
  voided: "Hold released",
  pay_at_pickup: "Pay at pickup",
  answered: "Question answered",
  failed: "Ended, no money moved",
}

const MONEY: Record<Errand["state"]["kind"], string> = {
  calling: "none",
  signing_up: "none",
  asking: "none",
  awaiting_approval: "waiting",
  authorized: "held",
  paid: "captured",
  voided: "voided",
  pay_at_pickup: "outside PayPal",
  answered: "none",
  failed: "none",
}

const dollars = (cents: number) => Math.round(cents) / 100
const ASK = /asked for \$([\d,]+\.\d{2})/

export function ledgerRows(errands: Errand[]): LedgerRow[] {
  return errands
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((errand) => {
      const { state, input } = errand
      const blocks = errand.transcript.filter((line) => line.speaker === "system" && line.text.startsWith("Blocked: "))
      const ask = blocks.map((line) => ASK.exec(line.text)?.[1]).findLast(Boolean)
      const deal = "deal" in state ? state.deal : undefined
      const total = deal ? dollars(deal.totalCents) : 0
      const blocked = state.kind === "failed" && state.reason === "no_deal" && blocks.length > 0
      const orderId = "orderId" in state ? state.orderId : null
      return {
        errand: errand.id,
        created: errand.createdAt,
        day: errand.createdAt.slice(0, 10),
        shop: input.shop.name,
        customer: input.customerName,
        outcome: blocked ? "Blocked by the money gate" : OUTCOME[state.kind],
        money: MONEY[state.kind],
        limit: input.mode === "order" ? dollars(input.maxCents) : null,
        agreed: deal ? total : null,
        held: state.kind === "authorized" ? total : 0,
        paid: state.kind === "paid" ? total : 0,
        released: state.kind === "voided" ? total : 0,
        blockedAsk: ask ? Number(ask.replace(/,/g, "")) : null,
        gateBlocks: blocks.length,
        payPalOrder: orderId,
        authorization: state.kind === "authorized" ? state.authorizationId : null,
        capture: state.kind === "paid" ? state.captureId : null,
        receiptHash: "receipt" in state ? state.receipt.hash : null,
        receiptOnOrder: orderId ? "in custom_id" : "no PayPal order",
      }
    })
}
