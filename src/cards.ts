import { DatabaseSync } from "node:sqlite"
import type { Deal, Errand } from "./domain/errand.ts"

export type ShopCard = {
  phone: string
  name: string
  payeeEmail: string | null
  lastDeal: Deal
  receiptHash: string | null
  verifiedAt: string
  calls: number
}

export type Cards = {
  record(errand: Errand): void
  get(phone: string): ShopCard | undefined
}

export function sqliteCards(path: string): Cards & { close(): void } {
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE IF NOT EXISTS cards (phone TEXT PRIMARY KEY, card TEXT)")
  const read = db.prepare("SELECT card FROM cards WHERE phone = ?")
  const write = db.prepare("INSERT OR REPLACE INTO cards (phone, card) VALUES (?, ?)")

  function get(phone: string): ShopCard | undefined {
    const row = read.get(phone) as { card: string } | undefined
    return row && JSON.parse(row.card)
  }

  return {
    get,
    close: () => db.close(),
    record({ input, state }) {
      if (!("deal" in state)) return
      const { phone, name } = input.shop
      const previous = get(phone)
      const card: ShopCard = {
        phone,
        name,
        payeeEmail: state.deal.payeeEmail ?? previous?.payeeEmail ?? null,
        lastDeal: state.deal,
        receiptHash: "receipt" in state ? state.receipt.hash : null,
        verifiedAt: new Date().toISOString(),
        calls: (previous?.calls ?? 0) + 1,
      }
      write.run(phone, JSON.stringify(card))
    },
  }
}
