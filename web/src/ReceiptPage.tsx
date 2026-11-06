import { useEffect, useState, type CSSProperties } from "react"
import { canonicalReceipt, type ErrandState } from "../../src/domain/errand.ts"
import type { ReceiptView } from "../../src/receipt.ts"
import { api, useSimulated } from "./api.ts"
import { Missing } from "./Missing.tsx"
import { Receipt, type Stamp } from "./Receipt.tsx"

const OUTCOMES: Partial<Record<ErrandState["kind"], Stamp>> = {
  awaiting_approval: { text: "Agreed", tone: "agreed" },
  authorized: { text: "Held", tone: "hold" },
  paid: { text: "Paid", tone: "paid" },
  voided: { text: "Voided", tone: "void" },
  pay_at_pickup: { text: "Pay in store", tone: "agreed" },
}
import { shopHue } from "./shops.ts"

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function verdict(view: ReceiptView, local: string | undefined, simulated: boolean) {
  if (!local) return { tone: "checking", title: "Checking the transcript", detail: "Your browser is hashing it now." }
  if (local !== view.hash || (view.orderId && !view.payPalError && local !== view.payPalCustomId))
    return { tone: "mismatch", title: "Does not match", detail: "The transcript, the hash and PayPal's copy do not agree. Do not trust this receipt." }
  if (view.payPalError)
    return {
      tone: "verified",
      title: "Unchanged since the deal",
      detail: "The transcript matches Dial's own hash. PayPal's copy could not be read just now, so this check did not compare it.",
    }
  if (!view.orderId)
    return {
      tone: "verified",
      title: "Unchanged since the deal",
      detail: "This deal is paid in store, so no PayPal order holds a copy. The transcript still matches Dial's own hash.",
    }
  return {
    tone: "verified",
    title: "Unchanged since the deal",
    detail: `Your browser hashed the transcript below and got the value stored on the ${simulated ? "simulated " : ""}PayPal order.`,
    note: `It shows what was said, not what the shop meant.${simulated ? " In this simulation the PayPal copy lives in Dial's own stand-in, so the check shows how it works, not that PayPal holds it." : ""}`,
  }
}

export function ReceiptPage({ id }: { id: string }) {
  const [view, setView] = useState<ReceiptView | null>()
  const [local, setLocal] = useState<string>()
  const simulated = useSimulated()

  useEffect(() => {
    api.receipt(id).then(setView, () => setView(null))
  }, [id])

  useEffect(() => {
    if (!view) return
    document.title = `Receipt · ${view.shop.name} · Dial`
    void sha256(canonicalReceipt(view.shop, view.deal, view.lines)).then(setLocal)
  }, [view])

  if (view === undefined) return <main className="page"><p className="notice" aria-busy="true">Loading the receipt</p></main>
  if (view === null) return <Missing title="No receipt here" detail="A receipt exists only after the shop agrees a deal on the call, and only while the server keeps the errand." />

  const { shop, deal, lines } = view
  const result = verdict(view, local, simulated)

  return (
    <main className="page receipt-page">
      <header className="line-head" style={{ "--hue": shopHue(shop.name) } as CSSProperties}>
        <p className="kicker">Call receipt</p>
        <h1>{shop.name}</h1>
        <p className="request">Has this record changed since the deal? Your browser checks it here.</p>
      </header>

      <div className="verdict" data-tone={result.tone} role="status">
        <strong>{result.title}</strong>
        <span>{result.detail}</span>
      </div>
      {"note" in result && <p className="verdict-note">{result.note}</p>}

      <div className="errand-grid">
        <section className="captions" aria-labelledby="transcript-title">
          <header className="captions-head">
            <h2 id="transcript-title">Transcript up to the deal</h2>
            <span className="clock">{lines.length} lines</span>
          </header>
          <ol className="caption-list" tabIndex={0} aria-labelledby="transcript-title">
            {lines.map((line, index) => (
              <li key={index} className="caption" data-speaker={line.speaker}>
                {line.speaker !== "system" && <span className="caption-who">{line.speaker === "agent" ? "Dial" : shop.name}</span>}
                <p>{line.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <aside className="actions">
          <Receipt
            heading={shop.name}
            meta="Agreed on the call"
            rows={deal.items.map((item) => ({ label: item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name }))}
            total={{ label: "Total", cents: deal.totalCents }}
            notes={[
              { label: "Pickup", amount: deal.pickupTime },
              { label: "Pays", amount: deal.payeeEmail ?? "in store" },
              ...(shop.phone.startsWith("sim:") ? [] : [{ label: "Phone", amount: shop.phone }]),
            ]}
            stamp={OUTCOMES[view.outcome]}
          >
            <details className="receipt-hashes" open={result.tone === "mismatch"}>
              <summary>Show the hashes</summary>
              <dl className="receipt-proof">
                <div>
                  <dt>Hash of the transcript</dt>
                  <dd>{view.hash}</dd>
                </div>
                <div>
                  <dt>Hash your browser computed</dt>
                  <dd>{local ?? "Working"}</dd>
                </div>
                <div>
                  <dt>{simulated ? "Simulated PayPal custom_id" : "PayPal custom_id"}</dt>
                  <dd>{view.payPalCustomId ?? (view.payPalError ? "Could not be read just now." : "None. No PayPal order exists.")}</dd>
                </div>
                {view.orderId && (
                  <div>
                    <dt>{simulated ? "Simulated PayPal order" : "PayPal order"}</dt>
                    <dd>{view.orderId}</dd>
                  </div>
                )}
              </dl>
            </details>
          </Receipt>
        </aside>
      </div>
    </main>
  )
}
