import { createHash } from "node:crypto"
import { canonicalReceipt, type Deal, type ErrandState, type Line, type Shop } from "./domain/errand.ts"

export type ReceiptView = {
  shop: Pick<Shop, "name" | "phone">
  deal: Deal
  lines: Line[]
  hash: string
  orderId: string | null
  payPalCustomId: string | null
  payPalError: string | null
  outcome: ErrandState["kind"]
}

export function receiptHash(shop: Pick<Shop, "name" | "phone">, deal: Deal, lines: Line[]): string {
  return createHash("sha256").update(canonicalReceipt(shop, deal, lines)).digest("hex")
}
