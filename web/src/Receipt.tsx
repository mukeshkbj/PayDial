import NumberFlow from "@number-flow/react"
import { AnimatePresence, motion, useAnimate, useReducedMotion } from "motion/react"
import { useEffect, useRef, type ReactNode } from "react"
import { Icon } from "./Icon.tsx"

export type ReceiptRow = { label: string; amount?: string }

export type Stamp = { text: string; tone: "live" | "agreed" | "hold" | "paid" | "void" }

export const usd = { style: "currency", currency: "USD" } as const

export function Receipt({
  heading,
  meta,
  rows,
  total,
  notes = [],
  check,
  stamp,
  struck = false,
  children,
}: {
  heading: string
  meta?: string
  rows: ReceiptRow[]
  total?: { label: string; cents: number }
  notes?: ReceiptRow[]
  check?: string
  stamp?: Stamp
  struck?: boolean
  children?: ReactNode
}) {
  const [paper, jolt] = useAnimate()
  const reduce = useReducedMotion()
  const first = useRef(true)

  useEffect(() => {
    if (first.current || !stamp || reduce) {
      first.current = false
      return
    }
    jolt(paper.current, { y: [0, 3, 0], rotate: [0, -0.4, 0] }, { duration: 0.28, delay: 0.14 })
  }, [stamp?.text])

  return (
    <div className="receipt-shadow" ref={paper}>
      <article className="receipt" aria-label={`Receipt, ${heading}`}>
        <header className="receipt-head">
          <h2>{heading}</h2>
          {meta && <p>{meta}</p>}
        </header>
        <ul className="receipt-rows">
          <AnimatePresence initial={false}>
            {rows.map((row) => (
              <motion.li
                key={row.label.replace(/^\d+ × /, "")}
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
              >
                <Leader row={row} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        {total && (
          <div className="receipt-total leader" data-struck={struck || undefined}>
            <span>{total.label}</span>
            <span className="dots" aria-hidden />
            <NumberFlow className="amount" value={total.cents / 100} format={usd} locales="en-US" />
          </div>
        )}
        {check && (
          <p className="receipt-check">
            <Icon name="done" /> {check}
          </p>
        )}
        {notes.length > 0 && (
          <ul className="receipt-notes">
            {notes.map((row) => (
              <li key={row.label}>
                <Leader row={row} />
              </li>
            ))}
          </ul>
        )}
        {stamp && (
          <p key={stamp.text} className="stamp" data-tone={stamp.tone}>
            {stamp.text}
          </p>
        )}
        {children}
      </article>
    </div>
  )
}

function Leader({ row }: { row: ReceiptRow }) {
  return (
    <div className="leader">
      <span>{row.label}</span>
      {row.amount && (
        <>
          <span className="dots" aria-hidden />
          <span className="amount">{row.amount}</span>
        </>
      )}
    </div>
  )
}
