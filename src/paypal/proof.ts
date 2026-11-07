import { formatUsd } from "../domain/errand.ts"
import type { ErrandRecord } from "../errandStore.ts"
import { receiptHash } from "../receipt.ts"
import type { PayPal } from "./rest.ts"

const HEADER = "| Shop | Total | Dial state | PayPal order | Order status | Authorization | Capture | Receipt hash matches custom_id |\n|---|---|---|---|---|---|---|---|"

export async function proofTable(records: ErrandRecord[], paypal: PayPal): Promise<string> {
  const rows: string[] = []
  for (const { errand } of records) {
    const { state } = errand
    if (!("orderId" in state) || !("receipt" in state)) continue
    const order = await paypal.order(state.orderId)
    const hash = receiptHash(errand.input.shop, state.deal, errand.transcript.slice(0, state.receipt.lines))
    const matches = hash === state.receipt.hash && hash === order.customId
    const capture = order.captureId ? `${order.captureId} ${order.captureStatus}` : "none"
    rows.push(`| ${errand.input.shop.name} | ${formatUsd(state.deal.totalCents)} | ${state.kind} | ${state.orderId} | ${order.status} | ${order.authorizationStatus ?? "none"} | ${capture} | ${matches ? "yes" : "no"} |`)
  }
  return [HEADER, ...rows].join("\n")
}
