# Accessibility check, 2026-10-19

The build of 2026-10-19, served in simulation on port 8801, in Chrome at 1440px. I ran each check in the browser against the live pages. No screen reader ran. Two jobs are left to a person: an NVDA or VoiceOver run, and a session with a deaf or hard-of-hearing tester.

## Contrast (WCAG 1.4.3)

A script read every visible text node, combined its colour with the background layers under it, and computed the contrast ratio. Text that sits on a gradient or an image is skipped and counted. The limit is 4.5:1 for normal text and 3:1 for large text.

Pages: home, Rosa's shop page, `/text`, the errand page in each state (awaiting approval, held, paid, voided, pay in store, answered, failed), the receipt and the simulated PayPal page.

| Theme | Text nodes checked | Below the limit | Smallest margin over the limit |
|---|---|---|---|
| Light | 403 | 0 | 1.06 times the limit |
| Dark | 403 | 0 (see the note) | 1.06 times the limit |

Note: in dark mode the script flagged the last progress step ("Collected", "Pay at pickup", "Answered") at about 1.06:1. That text sits on a yellow pill drawn by a sibling element, which the script cannot see. Measured directly, the dark text on the pill is 11.91:1.

The 11 skipped nodes are the home hero text on its yellow gradient.

## Keyboard (WCAG 2.1.1, 2.4.3, 2.4.7)

- Every focusable control on the eight main pages shows a focus ring on focus, or its wrapper does (the search fields and the limit field draw the ring with `:focus-within`). The simulated PayPal page did not ring its "Dial, home" link; it now has one.
- No element has a positive `tabindex`, so the tab order is the reading order.
- A full errand with keys only, at 1440px light: the question heading takes focus when the shop asks; Tab reaches "Yes, plain is fine" and Enter answers. Focus moves to the order panel when the deal arrives. Tab reaches "Approve $5.44 with PayPal", and Enter opens PayPal. Two Tabs reach "Approve $5.44", and Enter returns to Dial with focus on the order panel. Tab reaches "Picked up, all good", and Enter pays the shop.
- Defect found and fixed: after "Picked up, all good", focus fell to the page body. It now moves to the order panel.

## What a screen reader is told

- Every page has one `h1`, a skip link to the content, and `main`, `header` and `footer` landmarks. The simulated PayPal page has no skip link; it holds one heading and two buttons.
- The captions are a `role="log"` list, so new lines are announced as they arrive. Each line names its speaker.
- The errand page has a `role="status"` line that states each new step in words.
- Errors use `role="alert"`.
- `/text` uses a `role="log"` thread, with "You:" and "Dial:" before each message for screen readers.

## Time limits (WCAG 2.2.1)

A shop holds for 90 seconds while Dial asks the customer a question. The customer can ask the shop to hold longer, twice, on the web or by texting WAIT. Each request restarts the 90 seconds.

## Motion (WCAG 2.3.3)

- A global `prefers-reduced-motion: reduce` rule cuts every CSS animation and transition to 1 ms.
- Motion runs with `reducedMotion="user"`.
- Page view transitions are skipped under reduced motion.
- The receipt's stamp animation checks `useReducedMotion()`.

## Correction after a second review

A second review found three faults that this check missed. They are fixed.

- The progress steps and the "Dial should" choice read each name twice, for example "Calling Calling". A hidden `::after` copy of the label, which keeps the width steady when the label turns bold, reached the accessibility tree. It now uses `content: attr(data-label) / ""`, so it has no accessible text. The browser's accessibility tree now reads "Calling", "Agreed", "Held" and "Paid" once each.
- At 390px the order panel showed above the captions, but the page listed the captions first. So the reading and Tab order did not match the screen, and the line "the tab order is the reading order" above was wrong at that width. The page now lists the order panel first at every width; on desktop, CSS grid places it in the right column.
- After the second "hold longer" request the button disappeared and focus fell to the page. The panel now says "{shop} cannot hold any longer." and focus returns to the question. The hold and end-call links are now 44px tall. The countdown never shows more than 1:30.
