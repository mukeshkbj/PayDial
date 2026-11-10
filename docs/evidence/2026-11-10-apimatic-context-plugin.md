# APIMatic Context Plugin for PayPal (2026-11-10)

Installed on the builder's PC with `npx context-plugins install paypal`, which added the PayPal plugin to Claude Code, VS Code and Codex. The plugin's TypeScript skills were then used to review Dial's PayPal adapter (`src/paypal/rest.ts`) and the hold-collection code in `src/errands.ts`.

## What the plugin's context said

From `typescript-configuration-resilience`:

- Generate an idempotency key once per logical action and reuse it across retries of that action; a new logical attempt needs a new key.
- Never retry a 4xx other than 408 or 429 as if nothing happened.
- A write that failed on the way back may still have taken effect. Treat it as an unknown outcome and settle it by re-reading provider state, not by resending.

## What it found in Dial

Every capture of a hold sent the same `PayPal-Request-Id` (`<authorizationId>-capture`). Dial's collect-by job retries an unclaimed hold every hour. PayPal stores a response against its request id, so after one refused capture each hourly retry got the stored refusal back and could never succeed. And a capture whose reply was lost would have been sent again without checking whether PayPal had already captured it.

## What changed

- `PayPal.capture(authorizationId, attempt)`: attempt 1 keeps `<authorizationId>-capture`; attempt n sends `<authorizationId>-capture-n`.
- `collect` passes the attempt number, and before any retry reads the order back with `GET /v2/checkout/orders/{id}`. If PayPal already holds a capture that is not declined or failed, Dial records it and sends nothing.
- Tests: `src/paypal/rest.test.ts` checks the request ids; `src/errands.test.ts` checks that retries use attempts 1, 2, 3, and that a capture whose reply was lost is recorded once, not captured twice.

Dial calls PayPal's REST API directly rather than through the generated SDK, so the plugin was used as reference for the API's behaviour, not to generate code.
