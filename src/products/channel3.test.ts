import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { channel3, noProducts } from "./channel3.ts"

function fakeChannel3(t: TestContext, reply: unknown) {
  const original = globalThis.fetch
  const calls: { url: string; headers: Record<string, string>; body: any }[] = []
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return reply instanceof Response ? reply : Response.json(reply)
  }) as unknown as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

test("Channel3 search sends the key and maps each product to its first buyable offer", async (t) => {
  const calls = fakeChannel3(t, {
    products: [
      {
        title: "Plain concha, 6 pack",
        images: [{ url: "https://img/b.jpg" }, { url: "https://img/a.jpg", is_main_image: true }],
        offers: [{ domain: "no-url.example" }, { url: "https://shop.example/concha", domain: "shop.example", price: { price: 12.5, currency: "USD", availability: "InStock" } }],
      },
      { title: "No offers", offers: [] },
    ],
  })
  const online = await channel3({ apiKey: "c3" }).search("concha", 2)
  assert.equal(calls[0]!.url, "https://api.trychannel3.com/v1/search")
  assert.equal(calls[0]!.headers["x-api-key"], "c3")
  assert.deepEqual(calls[0]!.body, { query: "concha", limit: 8 })
  assert.deepEqual(online, [{ title: "Plain concha, 6 pack", price: 12.5, currency: "USD", url: "https://shop.example/concha", domain: "shop.example", availability: "InStock", image: "https://img/a.jpg" }])
})

test("a product whose title does not name every word of the query is left out", async (t) => {
  fakeChannel3(t, {
    products: [
      { title: "Toddler Everything Bagels T-Shirt", offers: [{ url: "https://gap.example/t", domain: "gap.example" }] },
      { title: "Sesame Bagel, dozen", offers: [{ url: "https://bakery.example/b", domain: "bakery.example" }] },
    ],
  })
  assert.deepEqual((await channel3({ apiKey: "c3" }).search("sesame bagels")).map((item) => item.title), ["Sesame Bagel, dozen"])
})

test("an empty query asks nothing, a failed request throws, and no key means no online results", async (t) => {
  const calls = fakeChannel3(t, new Response("quota", { status: 429 }))
  assert.deepEqual(await channel3({ apiKey: "c3" }).search("  "), [])
  assert.equal(calls.length, 0)
  await assert.rejects(channel3({ apiKey: "c3" }).search("bagels"), /Channel3 search failed \(429\): quota/)
  assert.deepEqual(await noProducts.search("bagels"), [])
  assert.equal(noProducts.source, "none")
})
