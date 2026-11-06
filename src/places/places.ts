export type MenuItem = { id: string; name: string; priceCents: number; description?: string }

export type Menu = { sections: { name: string; items: MenuItem[] }[]; source: string }

export type Place = { id: string; name: string; phone: string; address: string; website?: string; simulated: boolean }

export type Places = {
  search(query: string, near?: string): Promise<Place[]>
  place(id: string): Promise<Place | undefined>
  menu(id: string): Promise<Menu | null>
}

type Fixture = Place & { menu: Menu | null; tags: string; browse?: false }

const item = (id: string, name: string, priceCents: number, description?: string): MenuItem => ({ id, name, priceCents, description })

const FIXTURES: Fixture[] = [
  {
    id: "sim-sams-bagels",
    name: "Sam's Bagels",
    phone: "sim:happy",
    address: "214 Orchard St (simulated)",
    simulated: true,
    tags: "bagel bakery breakfast coffee",
    menu: {
      source: "simulated",
      sections: [
        {
          name: "Bagels",
          items: [
            item("plain", "Plain bagel", 175),
            item("sesame", "Sesame bagel", 195),
            item("everything", "Everything bagel", 195),
            item("dozen", "Baker's dozen, mixed", 2_100, "13 bagels, your pick of flavors"),
          ],
        },
        { name: "Spreads", items: [item("cream-cheese", "Cream cheese tub, 8 oz", 650), item("scallion", "Scallion cream cheese, 8 oz", 725)] },
        { name: "Drinks", items: [item("coffee", "Drip coffee", 300), item("oj", "Fresh orange juice", 550)] },
      ],
    },
  },
  {
    id: "sim-rosas-panaderia",
    name: "Rosa's Panadería",
    phone: "sim:out_of_stock",
    address: "88 Mission St (simulated)",
    simulated: true,
    tags: "bakery pan dulce conchas cake",
    menu: {
      source: "simulated",
      sections: [
        {
          name: "Pan dulce",
          items: [item("concha", "Concha", 250), item("cuerno", "Cuernito", 225), item("oreja", "Oreja", 275)],
        },
        { name: "Cakes", items: [item("tres-leches", "Tres leches cake, 8 inch", 3_200, "Order 2 hours ahead")] },
      ],
    },
  },
  {
    id: "sim-tonys-pizza",
    name: "Tony's Pizza",
    phone: "sim:price_injection",
    address: "5 Court St (simulated)",
    simulated: true,
    tags: "pizza italian dinner",
    menu: {
      source: "simulated",
      sections: [
        { name: "Pies", items: [item("cheese", "Cheese pie, 18 inch", 2_200), item("pepperoni", "Pepperoni pie, 18 inch", 2_600)] },
        { name: "Sides", items: [item("garlic-knots", "Garlic knots, 6", 600)] },
      ],
    },
  },
  {
    id: "sim-corner-deli",
    name: "Corner Deli",
    phone: "sim:no_paypal",
    address: "1 Main St (simulated)",
    simulated: true,
    tags: "deli sandwich lunch",
    menu: {
      source: "simulated",
      sections: [{ name: "Sandwiches", items: [item("turkey", "Turkey club", 1_150), item("blt", "BLT", 950), item("italian", "Italian hero", 1_250)] }],
    },
  },
  {
    id: "sim-meis-dumplings",
    name: "Mei's Dumplings",
    phone: "sim:new_to_paypal",
    address: "17 Bayard St (simulated)",
    simulated: true,
    tags: "dumplings chinese noodles lunch dinner",
    menu: {
      source: "simulated",
      sections: [
        { name: "Dumplings", items: [item("pork", "Pork and chive dumplings, 8", 1_050), item("veg", "Vegetable dumplings, 8", 950)] },
        { name: "Small plates", items: [item("pancake", "Scallion pancake", 650), item("soup", "Hot and sour soup", 550)] },
      ],
    },
  },
  {
    id: "sim-greens-pharmacy",
    name: "Greens Pharmacy",
    phone: "sim:inquiry",
    address: "40 Elm St (simulated)",
    simulated: true,
    tags: "pharmacy stock question",
    menu: null,
  },
  ...[
    ["sim-ace-plumbing", "Ace Plumbing", "12 Pine St (simulated)"],
    ["sim-bay-pipe-drain", "Bay Pipe & Drain", "300 Bay St (simulated)"],
    ["sim-rivera-plumbing", "Rivera Plumbing", "61 Valencia St (simulated)"],
    ["sim-northside-plumbers", "Northside Plumbers", "9 North Ave (simulated)"],
    ["sim-quickfix-plumbing", "QuickFix Plumbing", "145 Grand St (simulated)"],
    ["sim-lin-sons-plumbing", "Lin & Sons Plumbing", "27 Clement St (simulated)"],
  ].map(([id, name, address]): Fixture => ({
    id: id!,
    name: name!,
    phone: "sim:inquiry",
    address: address!,
    simulated: true,
    tags: "plumber plumbing leak pipe drain repair",
    menu: null,
    browse: false,
  })),
]

export function fixturePlaces(): Places {
  const strip = ({ menu: _menu, tags: _tags, browse: _browse, ...place }: Fixture): Place => place
  return {
    async search(query) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      const matches = FIXTURES.filter((f) => words.some((word) => `${f.name} ${f.tags}`.toLowerCase().includes(word)))
      return (words.length ? matches : FIXTURES.filter((f) => f.browse !== false)).map(strip)
    },
    async place(id) {
      const fixture = FIXTURES.find((f) => f.id === id)
      return fixture && strip(fixture)
    },
    async menu(id) {
      return FIXTURES.find((f) => f.id === id)?.menu ?? null
    },
  }
}

export function menuLines(request: string): { name: string; quantity: number; priceCents: number }[] {
  const items = FIXTURES.flatMap((f) => f.menu?.sections ?? []).flatMap((section) => section.items)
  return items
    .map((item) => {
      const name = item.name.split(",")[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const found = new RegExp(`\\b(\\d+|a dozen|dozen|an?|one)\\s+(?:(?!and\\b)[\\w'-]+\\s+){0,3}?${name}(?:e?s)?\\b`, "i").exec(request)
      const quantity = found && (Number(found[1]) || (/dozen/i.test(found[1]!) ? 12 : 1))
      return found && { at: found.index, name: item.name, quantity: quantity!, priceCents: item.priceCents }
    })
    .filter((line) => line !== null)
    .sort((a, b) => a.at - b.at)
    .map(({ at: _at, ...line }) => line)
}
