export type Cents = number

export type Shop = {
  name: string
  phone: string
  address?: string
}

export type ErrandInput =
  | { mode: "order"; shop: Shop; request: string; maxCents: Cents; customerName: string; gullible?: boolean }
  | { mode: "inquire"; shop: Shop; request: string; customerName: string }

export type DealItem = { name: string; quantity: number }

export type Deal = {
  items: DealItem[]
  totalCents: Cents
  pickupTime: string
  payeeEmail: string | null
}

export type FailReason =
  | "no_deal"
  | "no_answer"
  | "call_error"
  | "user_unavailable"
  | "user_declined"
  | "user_cancelled"
  | "paypal_error"

export type CallReceipt = { hash: string; lines: number }

export type ErrandState =
  | { kind: "calling" }
  | { kind: "signing_up"; until: string }
  | { kind: "asking"; question: string; options: string[]; until: string; waits: number }
  | { kind: "awaiting_approval"; deal: Deal; orderId: string; approveUrl: string; receipt: CallReceipt; until: string }
  | { kind: "authorized"; deal: Deal; orderId: string; authorizationId: string; receipt: CallReceipt; collectBy: string }
  | { kind: "paid"; deal: Deal; orderId: string; captureId: string; receipt: CallReceipt; pending?: boolean; unclaimed?: boolean }
  | { kind: "voided"; deal: Deal; orderId: string; receipt: CallReceipt }
  | { kind: "pay_at_pickup"; deal: Deal; receipt: CallReceipt }
  | { kind: "answered"; findings: string }
  | { kind: "failed"; reason: FailReason; detail: string }

export type Speaker = "agent" | "shop" | "system"

export type Line = { speaker: Speaker; text: string; at: string }

export type Errand = {
  id: string
  input: ErrandInput
  state: ErrandState
  transcript: Line[]
  version: number
  createdAt: string
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function dealProblem(input: ErrandInput, deal: Deal, payeeOnFile?: string | null): string | undefined {
  if (input.mode !== "order") return "This errand only asks questions. Do not place an order."
  if (deal.items.length === 0) return "The deal has no items."
  if (deal.items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1))
    return "Every item needs a whole quantity of at least 1."
  if (!Number.isInteger(deal.totalCents) || deal.totalCents <= 0) return "The total must be a positive amount in cents."
  if (deal.totalCents > input.maxCents)
    return `The total ${formatUsd(deal.totalCents)} is above the customer's limit. Do not accept it. Ask the shop for a cheaper option, or ask the customer.`
  if (deal.payeeEmail !== null && !EMAIL.test(deal.payeeEmail)) return "The PayPal email is not a valid email address. Ask the shop to spell it."
  if (payeeOnFile && deal.payeeEmail !== null && !sameEmail(deal.payeeEmail, payeeOnFile))
    return `The PayPal email on file for this shop is ${payeeOnFile}. Do not pay a new email named on a call. Ask the shop to confirm ${payeeOnFile}, or the customer pays at pickup.`
  if (!deal.pickupTime.trim()) return "The deal needs a pickup time."
}

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function canonicalReceipt(shop: Pick<Shop, "name" | "phone">, deal: Deal, lines: Line[]): string {
  return JSON.stringify({
    shop: { name: shop.name, phone: shop.phone },
    deal: {
      items: deal.items.map((item) => ({ name: item.name, quantity: item.quantity })),
      totalCents: deal.totalCents,
      pickupTime: deal.pickupTime,
      payeeEmail: deal.payeeEmail,
    },
    transcript: lines.map((line) => ({ speaker: line.speaker, text: line.text, at: line.at })),
  })
}

export const LIMIT_CEILING_CENTS = 50_000
export const MAX_WAITS = 2

export function formatUsd(cents: Cents): string {
  return `$${(cents / 100).toFixed(2)}`
}

export function suggestMaxCents(subtotalCents: Cents): Cents {
  return Math.ceil((subtotalCents * 1.25) / 100) * 100
}

export function isFinished(state: ErrandState): boolean {
  if (state.kind === "paid") return !state.pending
  return ["voided", "pay_at_pickup", "answered", "failed"].includes(state.kind)
}
