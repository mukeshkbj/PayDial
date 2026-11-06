import { useEffect } from "react"
import { navigate } from "./api.ts"

export function Missing({ title, detail }: { title: string; detail: string }) {
  useEffect(() => {
    document.title = `${title} · Dial`
  }, [title])

  return (
    <main className="page missing">
      <header className="line-head">
        <p className="kicker">Not found</p>
        <h1>{title}</h1>
        <p className="request">{detail}</p>
      </header>
      <a className="button ink" href="/" onClick={(event) => (event.preventDefault(), navigate("/"))}>
        Find a shop
      </a>
    </main>
  )
}
