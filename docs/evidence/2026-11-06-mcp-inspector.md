# MCP Inspector run, production-like server (2026-11-06)

The server ran as it will on Render, but on localhost and in simulation: `PUBLIC_URL=https://dial-preflight.example/` (trailing slash on purpose), `DIAL_MCP_KEYS=pfkey`, a fresh `DIAL_DB`, and the built web app. The client was MCP Inspector 0.17.2 in CLI mode, with `--transport http` against `http://localhost:8799/mcp/pfkey`.

- `POST /mcp` without the key returned 401.
- `tools/list` returned `find_shops, get_menu, dial_shop, get_errand, answer_errand`.
- `find_shops` with `query=bakery` returned Sam's Bagels and Rosa's Panadería, both marked `simulated: true`.
- `get_menu` with `shop_id=sim-rosas-panaderia` returned the Pan dulce menu. Concha costs 250 cents.
- `dial_shop` for "2 Concha" from Rosa's Panadería, limit $10, customer Maya, returned `status: calling` and a live view at `https://dial-preflight.example/errand/<id>`.
- `get_errand` returned `status: asking` with "Rosa's Panadería is out of Concha. Is the plain version okay?"
- `answer_errand` with "Yes, plain is fine" returned `status: calling`.
- `get_errand` returned `status: awaiting_approval` with a PayPal link for $5.44.

No tool returned a link or a step that moves money. The hosted run on Render repeats this check once the deploy exists.
