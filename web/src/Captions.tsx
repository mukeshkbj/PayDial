import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import type { Line, Speaker } from "../../src/domain/errand.ts"

export function Captions({ lines, names, startedAt, over }: { lines: Line[]; names: Record<Speaker, string>; startedAt: string; over: boolean }) {
  const list = useRef<HTMLOListElement>(null)
  const pinned = useRef(true)
  const end = lines.find((line) => line.speaker === "system" && line.text.startsWith("Call ended"))?.at ?? (over ? (lines.at(-1)?.at ?? startedAt) : undefined)

  useLayoutEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [lines.length])
  useWholeLines(list, lines.length)

  return (
    <section className="captions" id="captions">
      <header className="captions-head">
        <h2 id="captions-title">Live captions</h2>
        <Clock from={lines.find((line) => line.speaker !== "system")?.at} to={end} />
      </header>
      <ol
        ref={list}
        className="caption-list"
        role="log"
        aria-labelledby="captions-title"
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {lines.length === 0 && <li className="caption-wait">Ringing</li>}
        {lines.map((line, index) => (
          <li
            key={index}
            className="caption"
            data-speaker={line.speaker}
            data-blocked={line.text.startsWith("Blocked: ") || undefined}
            data-latest={(index === lines.length - 1 && !end) || undefined}
          >
            {line.speaker !== "system" && <span className="caption-who">{names[line.speaker]}</span>}
            <p>{line.text.replace(/^Blocked: /, "")}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}

function Clock({ from, to }: { from?: string; to?: string }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (to || !from) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [from, to])
  if (!from) return <span className="clock">{to ? "Not answered" : "Ringing"}</span>
  const seconds = Math.max(0, Math.floor(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000))
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  return to ? <span className="clock">Call ended · {time}</span> : <span className="clock live">On the line · {time}</span>
}

export function useWholeLines(list: RefObject<HTMLElement | null>, count: number) {
  useEffect(() => {
    const root = list.current
    if (!root) return
    const watch = new IntersectionObserver(
      (entries) => {
        for (const { target, intersectionRatio, boundingClientRect, rootBounds } of entries)
          target.toggleAttribute("data-gone", intersectionRatio < 0.98 && boundingClientRect.top < (rootBounds?.top ?? 0))
      },
      { root, threshold: [0, 0.98] },
    )
    for (const child of root.children) watch.observe(child)
    return () => watch.disconnect()
  }, [list, count])
}
