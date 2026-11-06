import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { googlePlaces } from "./google.ts"

type Call = { url: string; init: RequestInit }

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function fakeFetch(route: (url: string, init: RequestInit) => Response | undefined): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const res = route(url, init)
    if (!res) throw new Error(`unexpected request ${url}`)
    return res
  }) as typeof fetch
  return calls
}

const SHOP_ID = "ChIJshop"
const SITE = "https://sams.example"
const DETAILS = `https://places.googleapis.com/v1/places/${SHOP_ID}`
const OPENAI = "https://api.openai.com/v1/chat/completions"

const places = googlePlaces({ apiKey: "g-key", openaiApiKey: "o-key", model: "test-model" })
const fresh = () => googlePlaces({ apiKey: "g-key", openaiApiKey: "o-key", model: "test-model" })

const html = (body: string) => new Response(`<html><head><style>.x{}</style><script>var secret=1</script></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } })
const completion = (menu: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(menu) } }] })
const extracted = (...items: { name: string; price_usd: number | null; description?: string | null }[]) => ({
  sections: [{ name: "Menu", items: items.map((i) => ({ description: null, ...i })) }],
})

function menuRoutes(extra: Record<string, () => Response>, model: () => Response) {
  return (url: string) => {
    if (url === DETAILS) return Response.json({ id: SHOP_ID, websiteUri: SITE })
    if (url === OPENAI) return model()
    return extra[url]?.()
  }
}

const userText = (call: Call) => JSON.parse(call.init.body as string).messages[1].content as string

test("search sends the field mask and maps places, dropping phoneless ones", async () => {
  const calls = fakeFetch(() =>
    Response.json({
      places: [
        { id: "a", displayName: { text: "Sam's Bagels", languageCode: "en" }, formattedAddress: "214 Orchard St", internationalPhoneNumber: "+1 212-555-0100", websiteUri: SITE },
        { id: "b", displayName: { text: "No Phone Deli" }, formattedAddress: "2 Main St" },
        { id: "c", displayName: { text: "London Bakery" }, formattedAddress: "9 Soho Sq", internationalPhoneNumber: "+44 20 7946 0958" },
      ],
    }),
  )
  const found = await places.search("bagels", "Brooklyn")

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, "https://places.googleapis.com/v1/places:searchText")
  assert.equal(calls[0]!.init.method, "POST")
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers["X-Goog-Api-Key"], "g-key")
  assert.equal(headers["X-Goog-FieldMask"], "places.id,places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.websiteUri")
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { textQuery: "bagels near Brooklyn" })
  assert.deepEqual(found, [
    { id: "a", name: "Sam's Bagels", phone: "+12125550100", address: "214 Orchard St", website: SITE, simulated: false },
    { id: "c", name: "London Bakery", phone: "+442079460958", address: "9 Soho Sq", website: undefined, simulated: false },
  ])
})

test("search without a location sends the bare query and tolerates no results", async () => {
  const calls = fakeFetch(() => Response.json({}))
  assert.deepEqual(await places.search("bagels"), [])
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), { textQuery: "bagels" })
})

test("search throws Google's error message", async () => {
  fakeFetch(() => Response.json({ error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } }, { status: 403 }))
  await assert.rejects(places.search("bagels"), /API key not valid/)
})

test("place uses the unprefixed field mask, returns undefined on 404, throws on other errors", async () => {
  const calls = fakeFetch((url) => {
    if (url.endsWith("/gone")) return Response.json({ error: { message: "not found" } }, { status: 404 })
    if (url.endsWith("/broken")) return Response.json({ error: { message: "quota exceeded" } }, { status: 429 })
    return Response.json({ id: SHOP_ID, displayName: { text: "Sam's" }, formattedAddress: "1 St", internationalPhoneNumber: "+1 212 555 0100" })
  })
  assert.deepEqual(await places.place(SHOP_ID), { id: SHOP_ID, name: "Sam's", phone: "+12125550100", address: "1 St", website: undefined, simulated: false })
  assert.equal(calls[0]!.url, DETAILS)
  const headers = calls[0]!.init.headers as Record<string, string>
  assert.equal(headers["X-Goog-FieldMask"], "id,displayName,formattedAddress,internationalPhoneNumber,websiteUri")
  assert.equal(await places.place("gone"), undefined)
  await assert.rejects(places.place("broken"), /quota exceeded/)
})

test("menu: website text goes to the model with strict json_schema and comes back as cents with unique ids", async () => {
  const calls = fakeFetch(
    menuRoutes(
      { [SITE]: () => html("<h1>Sam&#39;s &amp; Co</h1><p>Latte $4.50</p>") },
      () =>
        completion({
          sections: [
            { name: "Drinks", items: [{ name: "Latte", price_usd: 4.5, description: "Oat or whole" }, { name: "Bagel", price_usd: 1.15, description: null }] },
            { name: "Specials", items: [{ name: "Latte", price_usd: 5, description: null }] },
          ],
        }),
    ),
  )
  const menu = await fresh().menu(SHOP_ID)

  assert.deepEqual(menu, {
    source: SITE,
    sections: [
      {
        name: "Drinks",
        items: [
          { id: "latte", name: "Latte", priceCents: 450, description: "Oat or whole" },
          { id: "bagel", name: "Bagel", priceCents: 115, description: undefined },
        ],
      },
      { name: "Specials", items: [{ id: "latte-2", name: "Latte", priceCents: 500, description: undefined }] },
    ],
  })
  const model = calls.find((c) => c.url === OPENAI)!
  const body = JSON.parse(model.init.body as string)
  assert.equal(body.model, "test-model")
  assert.equal(body.response_format.type, "json_schema")
  assert.equal(body.response_format.json_schema.strict, true)
  assert.equal(body.response_format.json_schema.name, "menu")
  assert.equal((model.init.headers as Record<string, string>).authorization, "Bearer o-key")
  assert.match(userText(model), /Sam's & Co Latte \$4\.50/)
  assert.doesNotMatch(userText(model), /secret|<h1>|\.x\{\}/)
})

test("menu uses a custom OpenAI base url", async () => {
  const calls = fakeFetch((url) => {
    if (url === DETAILS) return Response.json({ id: SHOP_ID, websiteUri: SITE })
    if (url === SITE) return html("Latte $4")
    if (url === "http://llm.test/v1/chat/completions") return completion(extracted({ name: "Latte", price_usd: 4 }))
  })
  const custom = googlePlaces({ apiKey: "g", openaiApiKey: "o", model: "m", openaiBaseUrl: "http://llm.test/v1" })
  assert.equal((await custom.menu(SHOP_ID))?.sections[0]!.items[0]!.priceCents, 400)
  assert.ok(calls.some((c) => c.url === "http://llm.test/v1/chat/completions"))
})

test("menu follows one same-site menu link and includes its text", async () => {
  const calls = fakeFetch(
    menuRoutes(
      {
        [SITE]: () =>
          html(
            `<a href="https://other.example/menu">Menu</a><a href="/about">About</a><a href="mailto:menu@sams.example">Menu mail</a>` +
              `<a href="/our-food">See our <b>Menu</b></a><a href="/menu-2">Menu 2</a>Welcome home page`,
          ),
        [`${SITE}/our-food`]: () => html("Everything bagel $3.25"),
        [`${SITE}/menu-2`]: () => html("should never be fetched"),
      },
      () => completion(extracted({ name: "Everything bagel", price_usd: 3.25 })),
    ),
  )
  const menu = await fresh().menu(SHOP_ID)

  assert.equal(menu?.sections[0]!.items[0]!.priceCents, 325)
  assert.deepEqual(
    calls.map((c) => c.url),
    [DETAILS, SITE, `${SITE}/our-food`, OPENAI],
  )
  assert.match(userText(calls[3]!), /Welcome home page[\s\S]*Everything bagel \$3\.25/)
})

test("menu still works when the menu link fails to load", async () => {
  fakeFetch(
    menuRoutes(
      { [SITE]: () => html(`<a href="/menu">Menu</a>Latte $4`), [`${SITE}/menu`]: () => new Response("nope", { status: 500 }) },
      () => completion(extracted({ name: "Latte", price_usd: 4 })),
    ),
  )
  assert.equal((await fresh().menu(SHOP_ID))?.sections[0]!.items[0]!.priceCents, 400)
})

test("menu caps the website body and the text sent to the model", async () => {
  const calls = fakeFetch(menuRoutes({ [SITE]: () => html("word ".repeat(200_000)) }, () => completion(extracted({ name: "Latte", price_usd: 4 }))))
  await fresh().menu(SHOP_ID)
  const sent = userText(calls.find((c) => c.url === OPENAI)!).length
  assert.ok(sent <= 30_000, `sent ${sent} chars`)
  assert.ok(sent > 20_000, `sent ${sent} chars`)
})

test("menu is null without a website and never calls the model", async () => {
  const calls = fakeFetch((url) => (url === DETAILS ? Response.json({ id: SHOP_ID }) : undefined))
  assert.equal(await fresh().menu(SHOP_ID), null)
  assert.equal(calls.length, 1)
})

test("menu skips unpriced items, drops empty sections, and is null when nothing is priced", async () => {
  fakeFetch(
    menuRoutes(
      { [SITE]: () => html("Menu") },
      () =>
        completion({
          sections: [
            { name: "Drinks", items: [{ name: "Latte", price_usd: 4, description: null }, { name: "Market price fish", price_usd: null, description: null }, { name: "Free", price_usd: 0, description: null }] },
            { name: "Ask us", items: [{ name: "Cake", price_usd: null, description: null }] },
          ],
        }),
    ),
  )
  const menu = await fresh().menu(SHOP_ID)
  assert.deepEqual(
    menu?.sections.map((s) => [s.name, s.items.map((i) => i.name)]),
    [["Drinks", ["Latte"]]],
  )

  fakeFetch(menuRoutes({ [SITE]: () => html("Menu") }, () => completion(extracted({ name: "Cake", price_usd: null }))))
  assert.equal(await fresh().menu(SHOP_ID), null)
})

test("menu returns null on failures and retries them next time", async () => {
  let modelUp = false
  const calls = fakeFetch(menuRoutes({ [SITE]: () => html("Latte $4") }, () => (modelUp ? completion(extracted({ name: "Latte", price_usd: 4 })) : new Response("down", { status: 500 }))))
  const shop = fresh()
  assert.equal(await shop.menu(SHOP_ID), null)

  modelUp = true
  assert.equal((await shop.menu(SHOP_ID))?.sections[0]!.items[0]!.priceCents, 400)
  assert.equal(calls.filter((c) => c.url === OPENAI).length, 2)

  fakeFetch(menuRoutes({ [SITE]: () => new Response("", { status: 503 }) }, () => completion(extracted({ name: "Latte", price_usd: 4 }))))
  assert.equal(await fresh().menu(SHOP_ID), null)

  fakeFetch(menuRoutes({ [SITE]: () => html("Latte $4") }, () => completion({ sections: "garbage" })))
  assert.equal(await fresh().menu(SHOP_ID), null)

  fakeFetch(() => Response.json({ error: { message: "bad key" } }, { status: 403 }))
  assert.equal(await fresh().menu(SHOP_ID), null)
})

test("menu is cached per place id", async () => {
  const calls = fakeFetch(menuRoutes({ [SITE]: () => html("Latte $4") }, () => completion(extracted({ name: "Latte", price_usd: 4 }))))
  const shop = fresh()
  const first = await shop.menu(SHOP_ID)
  const made = calls.length
  assert.equal(await shop.menu(SHOP_ID), first)
  assert.equal(calls.length, made)
})
