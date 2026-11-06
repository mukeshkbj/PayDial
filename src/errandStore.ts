import { DatabaseSync } from "node:sqlite"
import type { Errand } from "./domain/errand.ts"

export type ErrandRecord = { errand: Errand; pickupKey: string; returnSecret: string }

export type ErrandStore = {
  save(record: ErrandRecord): void
  load(): ErrandRecord[]
}

export function sqliteErrands(path: string): ErrandStore & { close(): void } {
  const db = new DatabaseSync(path)
  db.exec("CREATE TABLE IF NOT EXISTS errands (id TEXT PRIMARY KEY, record TEXT)")
  const read = db.prepare("SELECT record FROM errands")
  const write = db.prepare("INSERT OR REPLACE INTO errands (id, record) VALUES (?, ?)")

  return {
    close: () => db.close(),
    save: (record) => void write.run(record.errand.id, JSON.stringify(record)),
    load: () => (read.all() as { record: string }[]).map((row) => JSON.parse(row.record)),
  }
}
