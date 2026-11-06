import { AnimatePresence, motion } from "motion/react"
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { formatUsd, isFinished, MAX_WAITS, type Deal, type Errand, type ErrandInput, type FailReason } from "../../src/domain/errand.ts"
import { api, navigate, pickupKey, useErrand, useSimulated } from "./api.ts"
import { Captions } from "./Captions.tsx"
import { Icon } from "./Icon.tsx"
import { Missing } from "./Missing.tsx"
import { Receipt, type Stamp } from "./Receipt.tsx"
import { shopHue } from "./shops.ts"

const FAILURES: Record<FailReason, string> = {
  no_deal: "No order was agreed",
  no_answer: "The shop did not answer",
  call_error: "The call could not be placed",
  user_unavailable: "The question went unanswered",
  user_declined: "You declined the payment",
  user_cancelled: "You ended the call",
  paypal_error: "PayPal returned an error",
}

export function ErrandPage({ id }: { id: string }) {
  const errand = useErrand(id)
  const simulated = useSimulated()
  const actions = useRef<HTMLElement>(null)

  const kind = errand?.state.kind
  useEffect(() => {
    if (!errand) return
    const shop = errand.input.shop.name
    document.title = kind === "asking" ? `Dial needs you · ${shop}` : kind === "awaiting_approval" ? `Approve on PayPal · ${shop}` : `${shop} · Dial`
  }, [kind, errand?.input.shop.name])

  const backFromPayPal = useRef(location.hash.includes("key="))
  useEffect(() => {
    if (!kind || !backFromPayPal.current) return
    backFromPayPal.current = false
    actions.current?.focus()
  }, [kind])

  const lastKind = useRef<string>(undefined)
  useEffect(() => {
    if (!kind) return
    const changed = lastKind.current !== undefined
    lastKind.current = kind
    if (changed) requestAnimationFrame(() => document.activeElement === document.body && actions.current?.focus())
  }, [kind])

  if (errand === null) return <Missing title="No errand here" detail="Dial has no errand at this address. Check the link, or start a new errand." />
  if (!errand) return <main className="page"><p className="notice" aria-busy="true">Connecting to the call</p></main>

  const { input, state } = errand

  return (
    <main className="page errand">
      <header className="errand-head" style={{ "--hue": shopHue(input.shop.name) } as CSSProperties}>
        <div>
          <p className="kicker">{input.mode === "order" ? "Ordering from" : "Asking"}</p>
          <h1>{input.shop.name}</h1>
        </div>
        <Rail errand={errand} />
      </header>

      {input.shop.phone === "browser" && !isFinished(state) && (
        <p className="notice">
          You are playing the shop.{" "}
          <a href={`/shop-line/${id}`} target="_blank">
            Open the shop line <Icon name="next" />
          </a>
        </p>
      )}

      <div className="errand-grid">
        <p className="sr-only" role="status">
          {announce(errand, simulated)}
        </p>
        <aside className="actions" ref={actions} tabIndex={-1} aria-label="Your order">
          <AnimatePresence
            mode="wait"
            initial={false}
            onExitComplete={() =>
              requestAnimationFrame(() => {
                if (document.activeElement === document.body) actions.current?.focus()
              })
            }
          >
            <motion.div
              key={stage(state.kind)}
              initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(4px)", transition: { duration: 0.12 } }}
            >
              <Action errand={errand} />
            </motion.div>
          </AnimatePresence>
        </aside>
        <Captions lines={errand.transcript} names={{ agent: "Dial", shop: input.shop.name, system: "" }} startedAt={errand.createdAt} over={isFinished(state)} />
      </div>
    </main>
  )
}

function stage(kind: Errand["state"]["kind"]) {
  return ["awaiting_approval", "authorized", "paid", "voided", "pay_at_pickup"].includes(kind) ? "deal" : kind
}

function Rail({ errand: { input, state } }: { errand: Errand }) {
  const labels =
    input.mode === "inquire"
      ? ["Calling", "Answered"]
      : state.kind === "pay_at_pickup"
        ? ["Calling", "Agreed", "Pay at pickup"]
        : ["Calling", "Agreed", "Held", state.kind === "voided" ? "Voided" : "Paid"]
  const reached = {
    calling: 0,
    signing_up: 0,
    asking: 0,
    awaiting_approval: 1,
    authorized: 2,
    paid: 4,
    voided: 3,
    pay_at_pickup: 3,
    answered: 2,
    failed: state.kind === "failed" && ["user_declined", "paypal_error"].includes(state.reason) ? 2 : 0,
  }[state.kind]
  const stopped = state.kind === "failed" || state.kind === "voided"
  const spot = Math.min(reached, labels.length - 1)

  return (
    <ol className="rail" aria-label="Progress" data-tone={stopped ? "stopped" : reached >= labels.length ? "done" : "current"}>
      {labels.map((label, index) => {
        const status = index < reached ? "done" : index === reached ? (stopped ? "stopped" : "current") : "todo"
        return (
          <li key={label} data-status={status} aria-current={status === "current" ? "step" : undefined}>
            {index === spot && <motion.span layoutId="rail-pill" className="rail-pill" transition={{ type: "spring", duration: 0.5, bounce: 0.15 }} />}
            <span data-label={label}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Action({ errand }: { errand: Errand }) {
  const { id, input, state } = errand
  const shop = input.shop.name
  const limit = input.mode === "order" ? input.maxCents : undefined
  const simulated = useSimulated()

  switch (state.kind) {
    case "calling":
      return (
        <Receipt
          heading={shop}
          meta={input.mode === "order" ? "Your request" : "Your question"}
          rows={[{ label: input.request }]}
          total={input.mode === "order" ? { label: "Your limit", cents: input.maxCents } : undefined}
          stamp={{ text: "On the line", tone: "live" }}
        >
          <div className="receipt-actions">
            <EndCall id={id} />
          </div>
        </Receipt>
      )
    case "signing_up":
      return <SigningUp id={id} shop={shop} phone={input.shop.phone} until={state.until} />
    case "asking":
      return <Question id={id} question={state.question} options={state.options} until={state.until} waits={state.waits} shop={shop} heard={errand.transcript.findLast((line) => line.speaker === "shop")?.text} />
    case "awaiting_approval":
      return (
        <DealReceipt id={id} shop={shop} deal={state.deal} limit={limit} stamp={{ text: "Agreed", tone: "agreed" }}>
          <a className="button paypal wide" href={state.approveUrl}>
            <span className="nowrap">Approve {formatUsd(state.deal.totalCents)}</span>
            <span className="nowrap">
              with <Icon name="paypal" /> PayPal
            </span>
          </a>
          <Holding until={state.until} />
        </DealReceipt>
      )
    case "authorized":
      return (
        <DealReceipt id={id} shop={shop} deal={state.deal} limit={limit} stamp={{ text: "Held", tone: "hold" }}>
          <Pickup id={id} total={formatUsd(state.deal.totalCents)} collectBy={state.collectBy} />
        </DealReceipt>
      )
    case "paid":
      return (
        <DealReceipt id={id} shop={shop} deal={state.deal} limit={limit} stamp={{ text: state.pending ? "Paying" : "Paid", tone: "paid" }} reference={simulated ? undefined : state.captureId} primary>
          <div className="finale">
            <p className="finale-title">
              {state.pending ? `PayPal is finishing the payment to ${shop}.` : joinedOnCall(errand) ? `${shop} joined PayPal on the call, and is paid.` : `${shop} is paid.`}
            </p>
            <p className="fine">
              {state.unclaimed
                ? `You did not pay or release the hold within a day, so Dial paid ${shop} ${formatUsd(state.deal.totalCents)}, as you agreed when you approved.`
                : simulated
                ? `In this simulation, ${formatUsd(state.deal.totalCents)} would reach ${state.deal.payeeEmail} on PayPal when you paid at the counter.`
                : `${formatUsd(state.deal.totalCents)} reached ${state.deal.payeeEmail} on PayPal when you paid at the counter.`}
            </p>
          </div>
        </DealReceipt>
      )
    case "voided":
      return (
        <DealReceipt id={id} shop={shop} deal={state.deal} limit={limit} stamp={{ text: "Voided", tone: "void" }} reference={simulated ? undefined : state.orderId} struck>
          <p className="outcome">{simulated ? "In this simulation, PayPal would release the hold, and you would not be charged." : "PayPal released the hold. You were not charged."}</p>
          <Again />
        </DealReceipt>
      )
    case "pay_at_pickup":
      return (
        <DealReceipt id={id} shop={shop} deal={state.deal} limit={limit} stamp={{ text: "Pay in store", tone: "agreed" }}>
          <p className="outcome">
            {shop} does not take PayPal. Pay {formatUsd(state.deal.totalCents)} when you collect.
          </p>
          <Again />
        </DealReceipt>
      )
    case "answered":
      return (
        <div className="panel">
          <h2 className="panel-title">{shop} says</h2>
          <p className="findings">{state.findings}</p>
          <Again />
        </div>
      )
    case "failed":
      return (
        <div className="panel failed">
          <h2 className="panel-title">{FAILURES[state.reason]}</h2>
          <p className="detail">{state.detail.replace(/^Error: /, "")}</p>
          <p className="fine">
            You asked {shop} for: {input.request}
          </p>
          <Retry input={input} />
          <Again />
        </div>
      )
  }
}

function DealReceipt({ id, shop, deal, limit, stamp, reference, struck, primary, children }: { id: string; shop: string; deal: Deal; limit?: number; stamp: Stamp; reference?: string; struck?: boolean; primary?: boolean; children: ReactNode }) {
  return (
    <Receipt
      heading={shop}
      meta="Agreed on the call"
      rows={deal.items.map((item) => ({ label: item.quantity > 1 ? `${item.quantity} × ${item.name}` : item.name }))}
      total={{ label: "Total", cents: deal.totalCents }}
      check={limit !== undefined && !struck && deal.totalCents <= limit ? `Under your ${formatUsd(limit)} limit` : undefined}
      notes={[
        { label: "Pickup", amount: deal.pickupTime },
        { label: "Pays", amount: deal.payeeEmail ?? "in store" },
        ...(reference ? [{ label: "Ref", amount: reference }] : []),
      ]}
      stamp={stamp}
      struck={struck}
    >
      <div className="receipt-actions">
        {children}
        <a className={primary ? "button ink wide" : "link"} href={`/receipt/${id}`} onClick={(event) => (event.preventDefault(), navigate(`/receipt/${id}`))}>
          Verify this receipt <Icon name="next" />
        </a>
        {primary && <Again />}
      </div>
    </Receipt>
  )
}

function EndCall({ id }: { id: string }) {
  const [ending, setEnding] = useState(false)
  return (
    <button className="link quiet" disabled={ending} onClick={() => (setEnding(true), void api.hangUp(id).catch(() => setEnding(false)))}>
      End the call
    </button>
  )
}

function Question({ id, question, options, until, waits, shop, heard }: { id: string; question: string; options: string[]; until: string; waits: number; shop: string; heard?: string }) {
  const [text, setText] = useState("")
  const title = useRef<HTMLHeadingElement>(null)
  const left = Math.min(useSecondsLeft(until), 90)

  useEffect(() => title.current?.focus(), [])
  useEffect(() => {
    if (waits >= MAX_WAITS && document.activeElement === document.body) title.current?.focus()
  }, [waits])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()

  async function send(answer: string) {
    setSending(true)
    setError(undefined)
    await api.answer(id, answer).catch((e: Error) => {
      setError(e.message)
      setSending(false)
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (text.trim()) void send(text.trim())
  }

  return (
    <div className="panel question">
      <p className="kicker">
        Dial needs you · {shop} is holding · <span className="hold">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left</span>
      </p>
      {heard && (
        <figure className="heard">
          <blockquote>{heard}</blockquote>
          <figcaption>
            {shop} · <a href="#captions">Read the call</a>
          </figcaption>
        </figure>
      )}
      <h2 className="panel-title" ref={title} tabIndex={-1}>
        {question}
      </h2>
      {options.length > 0 && (
        <div className="options">
          {options.map((option) => (
            <button key={option} className="button outline" disabled={sending} onClick={() => void send(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      <form className="answer" onSubmit={submit}>
        <label className="field grow">
          <span>{options.length ? "Or type an answer" : "Your answer"}</span>
          <input value={text} onChange={(e) => setText(e.target.value)} autoFocus={!options.length} disabled={sending} />
        </label>
        <button className="button ink" disabled={sending || !text.trim()}>
          Send
        </button>
      </form>
      <div className="question-actions">
        {waits < MAX_WAITS ? (
          <button className="link" disabled={sending} onClick={() => void api.wait(id).catch((e: Error) => setError(e.message))}>
            Ask {shop} to hold longer
          </button>
        ) : (
          <p className="fine">{shop} cannot hold any longer.</p>
        )}
        <EndCall id={id} />
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function SigningUp({ id, shop, phone, until }: { id: string; shop: string; phone: string; until: string }) {
  const simulated = useSimulated()
  const left = useSecondsLeft(until)
  const [text, setText] = useState<string>()
  useEffect(() => {
    if (simulated) void api.thread(phone).then((thread) => setText(thread.findLast((message) => message.direction === "out")?.body), () => undefined)
  }, [simulated, phone])
  const link = text?.match(/https?:\/\/\S+/)?.[0]

  return (
    <div className="panel signing-up">
      <p className="kicker">
        No PayPal yet · <span className="hold">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left</span>
      </p>
      <h2 className="panel-title">{shop} is signing up for PayPal on the call.</h2>
      <ol className="signup-steps">
        <li data-status="done">Dial texts the shop a PayPal link</li>
        <li data-status="current">The shop signs up</li>
        <li>PayPal confirms the account</li>
        <li>You approve the payment</li>
      </ol>
      <p className="fine">Dial pays only the account PayPal confirms. If {shop} does not finish in time, you pay at pickup.</p>
      {simulated && text && link && (
        <section className="shop-phone" aria-label="The shop's phone, simulated">
          <p className="shop-phone-head">
            The shop's phone <span className="tag">Simulated</span>
          </p>
          <p className="sms-bubble" data-from="dial">
            {text.replace(link, "").trim().replace(/:$/, ".")}
          </p>
          <a className="button paypal wide" href={link} target="_blank">
            Sign up as {shop}
          </a>
        </section>
      )}
      <EndCall id={id} />
    </div>
  )
}

function joinedOnCall({ transcript }: Errand) {
  return transcript.some((line) => line.speaker === "system" && line.text.startsWith("PayPal confirmed the new account"))
}

function Pickup({ id, total, collectBy }: { id: string; total: string; collectBy: string }) {
  const [confirming, setConfirming] = useState(false)
  const [kept, setKept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [key] = useState(() => pickupKey(id))

  if (!key) return <p className="fine">PayPal holds {total}. Only the person who approved on PayPal can pay at the counter: on the page PayPal sent them back to, or by text if they ordered by text.</p>

  function finish(received: boolean) {
    setBusy(true)
    api.pickup(id, received, key!).catch((e: Error) => {
      setError(e.message)
      setBusy(false)
    })
  }

  if (confirming)
    return (
      <div className="confirm" role="group" aria-label="Confirm release">
        <p>Release the {total} hold? The shop is not paid. Do this only if the order is wrong or you will not pick it up.</p>
        <div className="options">
          <button className="button danger" disabled={busy} onClick={() => finish(false)}>
            Release the hold
          </button>
          <button className="button outline" autoFocus disabled={busy} onClick={() => (setConfirming(false), setKept(true))}>
            Keep it
          </button>
        </div>
        {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      </div>
    )

  return (
    <>
      <p className="fine">
        PayPal holds {total}. Pay at the counter, and the shop hands over your order once PayPal shows the payment. If you do not pay or release the hold by {when(collectBy)}, Dial pays the shop.
      </p>
      <button className="button ink wide" disabled={busy} onClick={() => finish(true)}>
        Pay {total} now
      </button>
      <button className="button outline wide" autoFocus={kept} disabled={busy} onClick={() => setConfirming(true)}>
        The order is wrong
      </button>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

function Retry({ input }: { input: ErrandInput }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  async function retry() {
    setBusy(true)
    setError(undefined)
    try {
      const errand = await api.startErrand(input)
      localStorage.setItem(`dial:key:${errand.id}`, errand.pickupKey)
      navigate(`/errand/${errand.id}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
      <button className="button outline wide" disabled={busy} onClick={() => void retry()}>
        {input.mode === "order" ? "Try the same order again" : "Ask the same question again"}
      </button>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

function Again() {
  return (
    <a className="link" href="/" onClick={(event) => (event.preventDefault(), navigate("/"))}>
      Start another errand <Icon name="next" />
    </a>
  )
}

function Holding({ until }: { until: string }) {
  const left = useSecondsLeft(until)
  return (
    <p className="fine">
      PayPal holds the money, and you pay at the counter. If you neither pay nor release the hold within a day, Dial pays the shop. The shop is waiting on the line for{" "}
      <span className="hold">
        {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
      </span>{" "}
      more.
    </p>
  )
}

function when(iso: string) {
  return new Date(iso).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" })
}

function useSecondsLeft(until: string) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.ceil((Date.parse(until) - now) / 1000))
}

function announce({ input, state }: Errand, simulated: boolean): string {
  const shop = input.shop.name
  switch (state.kind) {
    case "calling":
      return `On the line with ${shop}.`
    case "signing_up":
      return `${shop} has no PayPal and is signing up on the call.`
    case "asking":
      return `Dial needs you. ${state.question}`
    case "awaiting_approval":
      return `${shop} agreed ${formatUsd(state.deal.totalCents)}. Approve it on PayPal.`
    case "authorized":
      return `PayPal holds ${formatUsd(state.deal.totalCents)} for ${shop}.`
    case "paid":
      return `Paid. ${formatUsd(state.deal.totalCents)} ${simulated ? "would go" : "went"} to ${shop}.`
    case "voided":
      return "The hold is voided. You were not charged."
    case "pay_at_pickup":
      return `Agreed. Pay ${formatUsd(state.deal.totalCents)} in store.`
    case "answered":
      return `${shop} says: ${state.findings}`
    case "failed":
      return `${FAILURES[state.reason]}. ${state.detail}`
  }
}
