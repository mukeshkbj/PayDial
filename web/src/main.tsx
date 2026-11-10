import { lazy, StrictMode, Suspense, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { MotionConfig } from "motion/react"
import { api, navigate } from "./api.ts"
import { ChallengePage, ChallengeStart } from "./ChallengePage.tsx"
import { ErrandPage } from "./ErrandPage.tsx"
import { HomePage } from "./HomePage.tsx"
import { Missing } from "./Missing.tsx"
import { Mark } from "./Icon.tsx"
import { ReceiptPage } from "./ReceiptPage.tsx"
import { ShopLinePage } from "./ShopLinePage.tsx"
import { ShopPage } from "./ShopPage.tsx"
import { TextPage } from "./TextPage.tsx"
import "./styles.css"

const LedgerPage = lazy(() => import("./LedgerPage.tsx").then((m) => ({ default: m.LedgerPage })))

function route(path: string) {
  const [, page, id] = path.split("/")
  if (page === "shop" && id) return <ShopPage id={id} />
  if (page === "errand" && id) return <ErrandPage id={id} />
  if (page === "receipt" && id) return <ReceiptPage id={id} />
  if (page === "shop-line" && id) return <ShopLinePage id={id} />
  if (page === "text") return <TextPage />
  if (page === "challenge") return id ? <ChallengePage id={id} /> : <ChallengeStart />
  if (page === "ledger")
    return (
      <Suspense fallback={<p className="ledger-wait">Opening the ledger…</p>}>
        <LedgerPage dialKey={id} />
      </Suspense>
    )
  if (page) return <Missing title="No page here" detail="Dial has no page at this address. Check the link, or find a shop." />
  return <HomePage />
}

function App() {
  const [path, setPath] = useState(location.pathname)
  const [payPal, setPayPal] = useState<"simulated" | "sandbox">("simulated")
  useEffect(() => {
    api.config().then((config) => setPayPal(config.payPal), () => undefined)
  }, [])
  useEffect(() => {
    const update = () => {
      const swap = () =>
        flushSync(() => {
          setPath(location.pathname)
          scrollTo(0, 0)
        })
      if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(swap)
      else swap()
    }
    addEventListener("popstate", update)
    return () => removeEventListener("popstate", update)
  }, [])
  return (
    <MotionConfig reducedMotion="user" transition={{ type: "spring", duration: 0.35, bounce: 0 }}>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="masthead">
        <a
          className="brand"
          href="/"
          aria-label="Dial, home"
          onClick={(event) => {
            event.preventDefault()
            navigate("/")
          }}
        >
          <Mark />
          dial
        </a>
        <a
          className="masthead-link"
          href="/ledger"
          onClick={(event) => {
            event.preventDefault()
            navigate("/ledger")
          }}
        >
          Money ledger
        </a>
        <span className="sandbox">{payPal === "simulated" ? "Simulation · no real money" : "PayPal sandbox · no real money"}</span>
      </header>
      <div id="content" className="content" tabIndex={-1}>
        {route(path)}
      </div>
      <footer className="footer">
        <p className="footer-word" aria-hidden>
          dial
        </p>
        <div className="footer-line">
          <Mark />
          <p>Dial calls the shop and pays it through PayPal. Built for the PayPal AI Hackathon.</p>
        </div>
      </footer>
    </MotionConfig>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
