import NumberFlow from "@number-flow/react"
import { AnimatePresence, motion } from "motion/react"
import { useEffect, useState, type CSSProperties, type FormEvent } from "react"
import { formatUsd, suggestMaxCents, type ErrandInput } from "../../src/domain/errand.ts"
import type { ShopCard } from "../../src/cards.ts"
import type { Menu, Place } from "../../src/places/places.ts"
import { api, navigate, verifiedOn } from "./api.ts"
import { Icon } from "./Icon.tsx"
import { Missing } from "./Missing.tsx"
import { Receipt, usd } from "./Receipt.tsx"
import { PREVIEWS } from "./Previews.tsx"
import { SCENARIOS, morph, shopHue } from "./shops.ts"

type Mode = ErrandInput["mode"]

const NAME_KEY = "dial:name"

export function ShopPage({ id }: { id: string }) {
  const [shop, setShop] = useState<{ place: Place; menu: Menu | null; card: ShopCard | null }>()
  const [loadError, setLoadError] = useState<Error & { status?: number }>()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [mode, setMode] = useState<Mode>("order")
  const [note, setNote] = useState("")
  const [limit, setLimit] = useState<string>()
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "")
  const [browser, setBrowser] = useState(false)
  const [shopLine, setShopLine] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    api.config().then((config) => setShopLine(config.shopLine))
  }, [])

  useEffect(() => {
    api.shop(id).then((data) => {
      setShop(data)
      setMode(data.menu ? "order" : "inquire")
      document.title = `${data.place.name} · Dial`
    }, setLoadError)
  }, [id])

  if (loadError?.status === 404) return <Missing title="No shop here" detail="Dial has no shop at this address. Search for one by what it sells." />
  if (loadError) return <main className="page"><p className="notice error" role="alert">{loadError.message}</p></main>
  if (!shop) return <main className="page"><p className="notice" aria-busy="true">Opening the shop</p></main>

  const { place, menu } = shop
  const items = (menu?.sections ?? []).flatMap((section) => section.items).filter((item) => counts[item.id])
  const pieces = items.reduce((n, item) => n + counts[item.id], 0)
  const subtotal = items.reduce((sum, item) => sum + item.priceCents * counts[item.id], 0)
  const usesMenu = mode === "order" && menu !== null
  const request = usesMenu ? items.map((item) => `${counts[item.id]} ${item.name}`).join(", ") : note.trim()
  const suggested = subtotal ? (suggestMaxCents(subtotal) / 100).toFixed(2) : ""
  const limitText = limit ?? suggested
  const maxCents = /^\d+(\.\d{1,2})?$/.test(limitText) ? Math.round(Number(limitText) * 100) : NaN
  const problem = blocker({ request, usesMenu, mode, maxCents, name })

  function step(itemId: string, by: number) {
    setCounts((now) => ({ ...now, [itemId]: Math.max(0, (now[itemId] ?? 0) + by) }))
  }

  async function call(event: FormEvent) {
    event.preventDefault()
    if (problem || busy) return
    setBusy(true)
    setError(undefined)
    localStorage.setItem(NAME_KEY, name.trim())
    const target = { name: place.name, phone: browser ? "browser" : place.phone, address: place.address }
    const input: ErrandInput =
      mode === "order"
        ? { mode, shop: target, request, maxCents, customerName: name.trim() }
        : { mode, shop: target, request, customerName: name.trim() }
    try {
      const errand = await api.startErrand(input)
      if (errand.state.kind === "failed") throw new Error(errand.state.detail.replace(/^Error: /, ""))
      localStorage.setItem(`dial:key:${errand.id}`, errand.pickupKey)
      if (browser) open(`/shop-line/${errand.id}`, "_blank")
      navigate(`/errand/${errand.id}`)
    } catch (e) {
      setError(`${(e as Error).message}${browser ? " Choose “The simulated shop” to run without it." : ""}`)
      setBusy(false)
    }
  }

  return (
    <main className="page shop">
      <header className="storefront" style={{ "--hue": shopHue(place.name), viewTransitionName: morph("card", place.id) } as CSSProperties}>
        {PREVIEWS[place.phone] && (
          <div className="storefront-preview" aria-hidden style={{ viewTransitionName: morph("preview", place.id) }}>
            {PREVIEWS[place.phone]}
          </div>
        )}
        <a className="back" href="/" onClick={(event) => (event.preventDefault(), navigate("/"))}>
          <Icon name="back" /> All shops
        </a>
        <h1>{place.name}</h1>
        <p className="storefront-meta">
          {place.address.replace(" (simulated)", "")}
          {place.simulated && <span className="tag">Simulated shop</span>}
        </p>
        {shop.card && (
          <p className="storefront-ready">
            <Icon name="done" />
            <span>
              {shop.card.payeeEmail && <b>Agent-ready. </b>}
              {place.simulated ? "A simulated call" : "A call"} on {verifiedOn(shop.card)} confirmed this shop{" "}
              {shop.card.payeeEmail ? `takes PayPal at ${shop.card.payeeEmail}.` : "takes payment in store only."}
            </span>
          </p>
        )}
        {SCENARIOS[place.phone] && (
          <p className="storefront-story">
            <b>Simulated script.</b> {SCENARIOS[place.phone].story}
          </p>
        )}
      </header>

      <div className="shop-grid">
        <section className="menu" aria-labelledby="menu-title">
          {usesMenu ? (
            <>
              <h2 id="menu-title" className="sr-only">
                Menu
              </h2>
              {menu.sections.map((section) => (
                <div key={section.name} className="menu-section">
                  <h3>{section.name}</h3>
                  <ul>
                    {section.items.map((item) => {
                      const count = counts[item.id] ?? 0
                      return (
                        <li key={item.id} className="menu-item" data-picked={count > 0 || undefined}>
                          <div className="menu-text">
                            <span className="menu-name">{item.name}</span>
                            {item.description && <span className="menu-note">{item.description}</span>}
                          </div>
                          <span className="price">{formatUsd(item.priceCents)}</span>
                          <Stepper name={item.name} count={count} onStep={(by) => step(item.id, by)} />
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
              <p className="fine">Prices can change on the call. Dial never pays more than your limit.</p>
              <AnimatePresence>
                {items.length > 0 && (
                  <motion.a
                    className="ticket-bar"
                    href="#ticket"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 16 }}
                  >
                    <span>
                      {pieces} {pieces === 1 ? "item" : "items"}
                      <NumberFlow value={subtotal / 100} format={usd} locales="en-US" />
                    </span>
                    <span>
                      Review and call <Icon name="next" />
                    </span>
                  </motion.a>
                )}
              </AnimatePresence>
            </>
          ) : (
            <div className="ask">
              <h2 id="menu-title" className="section-title">
                {mode === "order" ? "What do you want to order?" : "What do you want to ask?"}
              </h2>
              {!menu && mode === "order" && <p className="fine">This shop has no menu online. Describe the order in your own words.</p>}
              <label className="field">
                <span className="sr-only">{mode === "order" ? "Your order" : "Your question"}</span>
                <textarea
                  rows={5}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={mode === "order" ? "One large cheese pizza, well done" : "Do you have it in stock? What time do you close?"}
                />
              </label>
            </div>
          )}
        </section>

        <form id="ticket" className="ticket" onSubmit={call} aria-label="Your call">
          {usesMenu && (
            <Receipt
              heading={place.name}
              meta="Your order"
              rows={items.length ? items.map((item) => ({ label: `${counts[item.id]} × ${item.name}`, amount: formatUsd(item.priceCents * counts[item.id]) })) : [{ label: "Add items from the menu" }]}
              total={{ label: "Subtotal", cents: subtotal }}
            />
          )}

          <div className="ticket-panel">
            <Segmented
              legend="Dial should"
              name="mode"
              options={["Place an order", "Ask a question"]}
              chosen={mode === "order" ? 0 : 1}
              onChoose={(index) => setMode(index === 0 ? "order" : "inquire")}
            />

            {mode === "order" && (
              <div className="field">
                <label htmlFor="limit">Your limit, with tax</label>
                <span className="money-input">
                  <span aria-hidden>$</span>
                  <input id="limit" inputMode="decimal" aria-describedby="limit-hint" value={limitText} onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))} onFocus={(e) => e.target.select()} placeholder="0.00" />
                </span>
                <small id="limit-hint">{subtotal ? "Subtotal plus 25%, rounded up to a whole dollar, for tax and price changes." : "Dial blocks any total above this."}</small>
              </div>
            )}

            <div className="field">
              <label htmlFor="name">Your first name</label>
              <input id="name" aria-describedby="name-hint" value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" placeholder="Maya" />
              <small id="name-hint">Dial tells the shop who it is calling for.</small>
            </div>

            {place.simulated && shopLine && (
              <Segmented
                legend="Who answers the phone?"
                name="who"
                options={["The simulated shop", "You, in a new tab"]}
                chosen={browser ? 1 : 0}
                onChoose={(index) => setBrowser(index === 1)}
              />
            )}

            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
            <button className="button ink wide call" disabled={busy || problem !== undefined} data-busy={busy || undefined}>
              <Icon name="phone" />
              {busy ? "Dialing" : `Call ${place.name}`}
            </button>
            <p className="fine center" aria-live="polite">
              {problem ?? (mode === "order" ? "Nothing is charged until you approve on PayPal." : "Dial shows the answer here.")}
            </p>
          </div>
        </form>
      </div>
    </main>
  )
}

function Stepper({ name, count, onStep }: { name: string; count: number; onStep: (by: number) => void }) {
  return (
    <motion.div layout className="stepper" data-open={count > 0 || undefined} role="group" aria-label={name} style={{ borderRadius: 999 }}>
      <AnimatePresence initial={false} mode="popLayout">
        {count > 0 && (
          <motion.span key="less" className="stepper-less" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}>
            <button type="button" onClick={() => onStep(-1)} aria-label={`One fewer ${name}`}>
              −
            </button>
            <output aria-live="polite">
              <NumberFlow value={count} />
            </output>
          </motion.span>
        )}
      </AnimatePresence>
      <motion.button layout="position" type="button" onClick={() => onStep(1)} aria-label={`One more ${name}`}>
        +
      </motion.button>
    </motion.div>
  )
}

function Segmented({ legend, name, options, chosen, onChoose }: { legend: string; name: string; options: string[]; chosen: number; onChoose: (index: number) => void }) {
  return (
    <fieldset className="choice">
      <legend>{legend}</legend>
      <div className="segmented">
        {options.map((label, index) => (
          <label key={label}>
            {chosen === index && <motion.span layoutId={`${name}-pill`} className="segmented-pill" />}
            <input type="radio" name={name} checked={chosen === index} onChange={() => onChoose(index)} />
            <span data-label={label}>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function blocker({ request, usesMenu, mode, maxCents, name }: { request: string; usesMenu: boolean; mode: Mode; maxCents: number; name: string }) {
  if (!request) return usesMenu ? "Add at least one item." : mode === "order" ? "Say what you want to order." : "Type your question."
  if (mode === "order" && !(maxCents > 0)) return "Set your limit in dollars, like 12.50."
  if (!name.trim()) return "Add your first name. The shop hears it."
}
