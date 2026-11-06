import assert from "node:assert/strict"
import { test } from "node:test"
import { fixturePlaces, menuLines } from "./places.ts"

test("simulated search returns every shop for no query, matches by word, and nothing for no match", async () => {
  const places = fixturePlaces()
  assert.equal((await places.search("")).length, 6)
  assert.deepEqual((await places.search("pizza")).map((place) => place.name), ["Tony's Pizza"])
  assert.deepEqual(await places.search("sushi"), [])
})

test("menu lines read quantities in digits or words, plurals, and any order of phrasing", () => {
  assert.deepEqual(menuLines("Pickup order: 2 Sesame bagels and a Drip coffee."), [
    { name: "Sesame bagel", quantity: 2, priceCents: 195 },
    { name: "Drip coffee", quantity: 1, priceCents: 300 },
  ])
  assert.deepEqual(menuLines("One 18 inch cheese pie for pickup."), [{ name: "Cheese pie, 18 inch", quantity: 1, priceCents: 2_200 }])
  assert.deepEqual(menuLines("2 Concha"), [{ name: "Concha", quantity: 2, priceCents: 250 }])
  assert.deepEqual(menuLines("something nice"), [])
})
