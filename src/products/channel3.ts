export type Online = { title: string; price: number | null; currency: string | null; url: string; domain: string; availability: string | null; image: string | null }

export type Products = { source: "channel3" | "none"; search(query: string, limit?: number): Promise<Online[]> }

type Offer = { url?: string; domain?: string; price?: { price?: number; currency?: string; availability?: string } }
type Product = { title?: string; images?: { url?: string; is_main_image?: boolean }[]; offers?: Offer[] }

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g)?.map((word) => word.replace(/(es|s)$/, "")) ?? []
const mentions = (title: string, query: string) => {
  const have = new Set(words(title))
  return words(query).every((word) => have.has(word))
}

export const noProducts: Products = { source: "none", search: async () => [] }

export function channel3({ apiKey, baseUrl = "https://api.trychannel3.com/v1" }: { apiKey: string; baseUrl?: string }): Products {
  return {
    source: "channel3",
    async search(query, limit = 3) {
      if (!query.trim()) return []
      const response = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query, limit: limit * 4 }),
      })
      if (!response.ok) throw new Error(`Channel3 search failed (${response.status}): ${(await response.text()).slice(0, 200)}`)
      const { products = [] } = (await response.json()) as { products?: Product[] }
      return products.flatMap((product) => {
        const offer = product.offers?.find((o) => o.url && o.domain)
        if (!product.title || !offer || !mentions(product.title, query)) return []
        const image = product.images?.find((i) => i.is_main_image)?.url ?? product.images?.[0]?.url ?? null
        return [{ title: product.title, price: offer.price?.price ?? null, currency: offer.price?.currency ?? null, url: offer.url!, domain: offer.domain!, availability: offer.price?.availability ?? null, image }]
      }).slice(0, limit)
    },
  }
}
