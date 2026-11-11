import { AgStudioAiModule, AgStudioLicenseManager, AgStudioModuleRegistry, createAiHarness, studioTheme, directLlmRunner, type AgAiHarnessSetupParams, type AgReportState, type AgStudioApi } from "ag-studio"
import { AgStudio } from "ag-studio-react"
import { useEffect, useMemo, useState, type FormEvent } from "react"
import { formatUsd } from "../../src/domain/errand.ts"
import type { LedgerRow } from "../../src/ledger.ts"
import { navigate } from "./api.ts"
import { HoldTimeline } from "./HoldTimeline.tsx"
import { ledgerAdapter, payPalTool, verifyReceipt, type PayPalToolSchema } from "./ledgerAgent.ts"

const licence = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_AG_STUDIO_LICENSE_KEY
if (licence) AgStudioLicenseManager.setLicenseKey(licence)
AgStudioModuleRegistry.registerModules([AgStudioAiModule])

const BRIEF = `You are the Ledger agent for Dial. Dial phones shops that take orders only by phone, and pays them through PayPal.
The "ledger" data source has one row per errand. Money columns are US dollars: held (authorized on PayPal, not yet captured), paid (captured to the shop), released (voided hold), agreed (the deal total), limit (the customer's ceiling) and blockedAsk (a price the money gate refused).
outcome and money say where each errand stands. receiptHash is the SHA-256 call receipt; receiptOnOrder says whether it sits in the PayPal order's custom_id.
Answer questions about holds, captures, voids and blocked deals from the data. Use verify_receipt to check a receipt.
When PayPal's own record matters, use the read-only tools from PayPal's Agent Toolkit: get_order with an errand's payPalOrder, list_disputes and get_dispute for disputes, list_transactions for settled payments. Say when an answer comes from PayPal rather than the ledger. Delegate to the widget, page or data agents to build or change the dashboard.
You cannot move money. No tool here captures, voids, refunds or pays, and Dial gives no AI one. If asked to, say that only the customer can, at the counter, with their pickup key.`

const usd = { format: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }) }
const text = (id: keyof LedgerRow, name: string, description: string) => ({ id, name, description, format: "textFormat" as const })
const money = (id: keyof LedgerRow, name: string, description: string) => ({ id, name, description, format: "currencyFormat" as const, formatOptions: usd })

const fields = [
  text("errand", "Errand", "Dial's errand id."),
  text("created", "Created", "When the errand started, in UTC."),
  text("shop", "Shop", "The shop Dial called."),
  text("customer", "Customer", "The customer's first name."),
  text("outcome", "Outcome", "Where the errand ended or stands."),
  text("money", "Money", "Where the money is: none, waiting, held, captured, voided or outside PayPal."),
  money("limit", "Limit", "The most the customer agreed to pay."),
  money("agreed", "Agreed", "The total the shop agreed, tax included."),
  money("held", "Held", "Authorized on PayPal and not yet captured."),
  money("paid", "Paid", "Captured to the shop."),
  money("released", "Released", "A hold the customer voided."),
  money("blockedAsk", "Refused ask", "A price the money gate refused."),
  { id: "gateBlocks", name: "Gate blocks", description: "Deals the money gate refused on this call.", format: "integerFormat" as const },
  text("payPalOrder", "PayPal order", "The PayPal Orders v2 id."),
  text("authorization", "Authorization", "The PayPal authorization id while held."),
  text("capture", "Capture", "The PayPal capture id once paid."),
  text("receiptHash", "Receipt hash", "SHA-256 of the shop, the deal and the transcript at the deal."),
  text("receiptOnOrder", "Receipt on PayPal", "Whether the receipt hash is in the PayPal order's custom_id."),
]

const theme = studioTheme.withParams({
  fontFamily: '"Atkinson Hyperlegible Next", system-ui, sans-serif',
  foregroundColor: "#1b1d24",
  backgroundColor: "#ffffff",
  accentColor: "#1b1d24",
  borderColor: "#dcdee3",
  borderRadius: 10,
  studioWrapperBackgroundColor: "#f3f4f6",
})

const initialState = {
  selectedPageId: "money",
  pages: [
    {
      id: "money",
      widgets: {
        held: { type: "value", format: { title: { text: "Held", enabled: true } }, dataMapping: { value: [{ id: "ledger.held", aggregation: "sum" }] } },
        paid: { type: "value", format: { title: { text: "Paid to shops", enabled: true } }, dataMapping: { value: [{ id: "ledger.paid", aggregation: "sum" }] } },
        released: { type: "value", format: { title: { text: "Released", enabled: true } }, dataMapping: { value: [{ id: "ledger.released", aggregation: "sum" }] } },
        blocked: { type: "value", format: { title: { text: "Gate refusals", enabled: true } }, dataMapping: { value: [{ id: "ledger.gateBlocks", aggregation: "sum" }] } },
        outcomes: {
          type: "donut-chart",
          format: { title: { text: "Errands by outcome", enabled: true } },
          dataMapping: { categoryKey: [{ id: "ledger.outcome" }], valueKey: [{ id: "ledger.errand", aggregation: "count" }] },
        },
        refusals: {
          type: "column-chart-grouped",
          format: { title: { text: "Prices the gate refused, by shop", enabled: true } },
          dataMapping: { categoryKey: [{ id: "ledger.shop" }], valueKey: [{ id: "ledger.gateBlocks", aggregation: "sum" }] },
        },
        ledger: {
          type: "grid",
          format: { title: { text: "Money ledger", enabled: true }, style: { columnAutoSize: true } },
          dataMapping: {
            cols: [
              { id: "ledger.created" },
              { id: "ledger.shop" },
              { id: "ledger.customer" },
              { id: "ledger.outcome" },
              { id: "ledger.agreed" },
              { id: "ledger.limit" },
              { id: "ledger.blockedAsk" },
              { id: "ledger.payPalOrder" },
              { id: "ledger.authorization" },
              { id: "ledger.capture" },
              { id: "ledger.receiptOnOrder" },
              { id: "ledger.errand" },
            ],
          },
        },
      },
      widgetLayout: {
        held: { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 8 },
        paid: { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 8 },
        released: { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 8 },
        blocked: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 8 },
        outcomes: { xTrack: 0, yTrack: 8, xSpan: 9, ySpan: 24 },
        refusals: { xTrack: 9, yTrack: 8, xSpan: 15, ySpan: 24 },
        ledger: { xTrack: 0, yTrack: 32, xSpan: 24, ySpan: 30 },
      },
    },
  ],
} as unknown as AgReportState

const KEY = "dial-ledger-key"
const remembered = () => {
  try {
    return localStorage.getItem(KEY) ?? undefined
  } catch {
    return undefined
  }
}
const remember = (key: string) => {
  try {
    localStorage.setItem(KEY, key)
  } catch {}
}

function KeyGate({ wrong }: { wrong: boolean }) {
  const [key, setKey] = useState("")
  useEffect(() => {
    document.title = "Money ledger · Dial"
  }, [])
  function open(event: FormEvent) {
    event.preventDefault()
    if (key.trim()) navigate(`/ledger/${encodeURIComponent(key.trim())}`)
  }
  return (
    <main className="page missing">
      <header className="line-head">
        <p className="kicker">Money ledger</p>
        <h1>Enter the Dial key</h1>
        <p className="request">
          {wrong ? "That key did not open the ledger. Check it and try again." : "On a hosted Dial the ledger is private to its operator. Judges: the key is in the Devpost testing notes."}
        </p>
      </header>
      <form className="ledger-key" onSubmit={open}>
        <label>
          <span className="sr-only">Dial key</span>
          <input value={key} onChange={(event) => setKey(event.target.value)} placeholder="Dial key" autoComplete="off" spellCheck={false} />
        </label>
        <button className="button ink" disabled={!key.trim()}>
          Open the ledger
        </button>
      </form>
    </main>
  )
}

export function LedgerPage({ dialKey }: { dialKey?: string }) {
  const key = dialKey ?? remembered()
  const suffix = key ? `/${encodeURIComponent(key)}` : ""
  const [ledger, setLedger] = useState<{ rows: LedgerRow[]; agent: boolean; payPalTools?: PayPalToolSchema[] } | null>()
  const [version, setVersion] = useState(0)
  const [agentOpen, setAgentOpen] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    document.title = "Money ledger · Dial"
    fetch(`/api/ledger${suffix}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (body && key) remember(key)
        setLedger(body)
      }, () => setLedger(null))
  }, [suffix, version])

  const ai = useMemo(() => {
    if (!ledger?.agent) return undefined
    const adapter = ledgerAdapter(`/api/ledger-turn${suffix}`)
    const payPal = (ledger.payPalTools ?? []).map((schema) => payPalTool(schema, `/api/ledger-paypal${suffix}`))
    return ({ api }: AgAiHarnessSetupParams) =>
      createAiHarness(api as AgStudioApi, ({ tools, builtIn }) => ({
        agents: [
          directLlmRunner({
            id: "ledger",
            name: "Ledger",
            description: "Reads Dial's money ledger and call receipts. It cannot move money.",
            adapter,
            instructions: () => BRIEF,
            tools: () => [tools.studio.viewSchema(), tools.studio.viewReport(), tools.studio.executeQuery(), verifyReceipt, ...payPal, tools.delegateTo(["widget", "page", "data"])],
          }),
          directLlmRunner({ ...builtIn.widget, adapter }),
          directLlmRunner({ ...builtIn.page, adapter }),
          directLlmRunner({ ...builtIn.data, adapter }),
        ],
        primary: "ledger",
        promptStarters: [
          { label: "Unclaimed holds", prompt: "Which holds are still on PayPal, and for how much?" },
          { label: "Blocked prices", prompt: "Which shops asked for more than the customer's limit?" },
          { label: "Verify a receipt", prompt: "Verify the call receipt of the most recent paid errand." },
          { label: "Disputes on PayPal", prompt: "Ask PayPal: are there any disputes on our orders?" },
          { label: "Pay the shop", prompt: "Capture the held payment for the shop now." },
        ],
      }))
  }, [ledger?.agent, ledger?.payPalTools, suffix])

  if (ledger === null) return <KeyGate wrong={Boolean(dialKey)} />
  if (!ledger) return <p className="ledger-wait">Reading the ledger…</p>

  const sum = (pick: (row: LedgerRow) => number) => Math.round(ledger.rows.reduce((total, row) => total + pick(row), 0) * 100)
  const held = ledger.rows.filter((row) => row.held > 0)
  const refused = ledger.rows.reduce((total, row) => total + row.gateBlocks, 0)
  const studioMode = agentOpen || editing ? "edit" : "view"

  return (
    <section className="page ledger" aria-labelledby="ledger-title">
      <header className="ledger-head">
        <div>
          <h1 id="ledger-title">Money ledger</h1>
          <p className="ledger-sum">
            {ledger.rows.length ? (
              <>
                {held.length ? (
                  <>
                    PayPal holds <b>{formatUsd(sum((row) => row.held))}</b> for {held.length} {held.length === 1 ? "order" : "orders"}.
                  </>
                ) : (
                  "PayPal holds no money right now."
                )}{" "}
                Shops have been paid <b>{formatUsd(sum((row) => row.paid))}</b>. The money gate
                refused <b>{refused}</b> {refused === 1 ? "price" : "prices"}.
              </>
            ) : (
              "No orders yet. Place one from the home page, or try the scam challenge, and it appears here."
            )}
          </p>
          <p>Every hold, capture and void, with its call receipt. The ledger agent reads all of it and builds charts. It has no tool that moves money.</p>
        </div>
        <div className="ledger-actions">
          {ledger.agent && (
            <button type="button" className={`button ${agentOpen ? "ink" : "outline"}`} aria-pressed={agentOpen} onClick={() => setAgentOpen((open) => !open)}>
              {agentOpen ? "Close the ledger agent" : "Ask the ledger agent"}
            </button>
          )}
          <button type="button" className={`button ${editing ? "ink" : "outline"}`} aria-pressed={editing} onClick={() => setEditing((on) => !on)}>
            {editing ? "Done editing" : "Edit dashboard"}
          </button>
          <button type="button" className="button outline" onClick={() => setVersion((v) => v + 1)}>
            Refresh
          </button>
        </div>
      </header>
      <div className="ledger-studio">
        <AgStudio
          key={`${version}-${studioMode}-${agentOpen}-${editing}`}
          theme={theme}
          data={{ sources: [{ id: "ledger", name: "Money ledger", data: ledger.rows, fields }] }}
          initialState={initialState}
          mode={studioMode}
          ai={agentOpen ? ai : undefined}
          panels={{ edit: { left: agentOpen && ai ? ["ai"] : [], right: editing ? ["edit", "data"] : [] }, view: { left: [], right: [] } }}
        />
      </div>
      <HoldTimeline key={`timeline-${version}`} rows={ledger.rows} />
      {!ledger.agent && <p className="ledger-note">The ledger agent needs ANTHROPIC_API_KEY on the server.</p>}
    </section>
  )
}
