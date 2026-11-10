import { Scheduler, type EventModelConfig } from "@bryntum/scheduler"
import "@bryntum/scheduler/scheduler.css"
import "@bryntum/scheduler/stockholm-light.css"
import "@bryntum/scheduler/fontawesome/css/fontawesome.css"
import "@bryntum/scheduler/fontawesome/css/solid.css"
import { useEffect, useRef } from "react"
import type { LedgerRow } from "../../src/ledger.ts"

const HOUR = 3_600_000
const COLOR: Record<string, string> = { captured: "green", held: "orange", voided: "gray", waiting: "blue", "outside PayPal": "teal", none: "gray" }
const usd = (value: number | null) => (value === null ? "" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value))
const clock = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" })

export function timeline(rows: LedgerRow[]) {
  const latest = Math.max(...rows.map((row) => Date.parse(row.created)))
  const recent = rows.filter((row) => latest - Date.parse(row.created) < 24 * HOUR || row.collectBy)
  const shops = [...new Set(recent.map((row) => row.shop))].sort()
  const events = recent.flatMap((row) => {
    const start = Date.parse(row.created)
    const end = Math.max(Date.parse(row.ended), start + 60_000)
    const blocked = row.outcome === "Blocked by the money gate"
    const call = {
      id: row.errand,
      resourceId: row.shop,
      name: `${row.customer}: ${blocked ? `blocked ${usd(row.blockedAsk)}` : row.agreed !== null ? usd(row.agreed) : row.outcome}`,
      startDate: new Date(start),
      endDate: new Date(end),
      eventColor: blocked ? "red" : (COLOR[row.money] ?? "gray"),
      tip: `${row.shop} · ${row.outcome}<br>Call ${clock(row.created)} to ${clock(row.ended)}${row.payPalOrder ? `<br>PayPal order ${row.payPalOrder}` : ""}`,
    }
    if (!row.collectBy) return [call]
    return [
      call,
      {
        id: `${row.errand}-hold`,
        resourceId: row.shop,
        name: `Held ${usd(row.agreed)} until the customer pays, or Dial collects it`,
        startDate: new Date(end),
        endDate: new Date(Date.parse(row.collectBy)),
        eventColor: "orange",
        eventStyle: "dashed",
        tip: `PayPal holds ${usd(row.agreed)} on authorization ${row.authorization}.<br>If the customer neither pays nor releases it, Dial captures it at ${clock(row.collectBy)}.`,
      },
    ]
  })
  const first = Math.min(...events.map((event) => event.startDate.getTime()))
  const last = Math.max(...events.map((event) => event.endDate.getTime()))
  const close = last - first < 3 * HOUR
  const pad = close ? 5 * 60_000 : HOUR
  return { shops, events, startDate: new Date(first - pad), endDate: new Date(last + pad), viewPreset: close ? "minuteAndHour" : "hourAndDay" }
}

export function HoldTimeline({ rows }: { rows: LedgerRow[] }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current || !rows.length) return
    const { shops, events, startDate, endDate, viewPreset } = timeline(rows)
    const scheduler = new Scheduler({
      appendTo: host.current,
      readOnly: true,
      startDate,
      endDate,
      viewPreset,
      eventStyle: "filled",
      rowHeight: 44,
      barMargin: 6,
      columns: [{ text: "Shop", field: "name", width: 190 }],
      resources: shops.map((name) => ({ id: name, name })),
      events: events as unknown as EventModelConfig[],
      features: { eventTooltip: { template: ({ eventRecord }: { eventRecord: { get(field: string): string } }) => `<div>${eventRecord.get("tip")}</div>` } },
    })
    void scheduler.zoomToFit({ leftMargin: 40, rightMargin: 40 })
    return () => scheduler.destroy()
  }, [rows])

  if (!rows.length) return null
  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <h2 id="timeline-title">Calls and holds over time</h2>
      <p>
        Bryntum Scheduler, one row per shop, from the latest day of calls. Each bar is a call, from the first word to the last event. Green is paid to the shop, blue waits for PayPal approval, red was blocked by the money gate, grey moved no
        money. An orange dashed bar is a payment PayPal still holds, up to the time Dial collects it for the shop. Read-only: nothing here moves money.
      </p>
      <div className="timeline-host" ref={host} />
    </section>
  )
}
