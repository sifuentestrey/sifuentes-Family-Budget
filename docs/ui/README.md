# Family Budget UI Direction

The UI should feel like a calm financial control center, not an accounting spreadsheet. Rocket Money is useful inspiration for simplicity, but this app should be more household/cash-flow focused and less subscription-centric.

## Design principles

- One primary question per screen: **How much can we safely spend?**
- Large numbers, short labels, generous spacing.
- Avoid dense tables on the home screen.
- Use progressive disclosure: details appear when a user taps a card.
- Show confidence/source when automation makes an inference.
- Never make the user manually enter a bill that can be discovered automatically.
- Mobile-first; desktop expands the same hierarchy rather than becoming a dashboard of tiny widgets.

## Primary navigation

Mobile bottom navigation:

1. Home
2. Bills
3. Spending
4. Income
5. More

Desktop uses the same five sections in a compact left rail.

## Home screen hierarchy

1. Greeting + current period
2. **Safe to spend** hero card
3. Next bills / upcoming obligations
4. Next paycheck + forecast
5. Spending snapshot
6. Items needing review

### Safe-to-spend card

Example:

**$1,284**
Safe to spend
through Aug 17

Small supporting text:
`$2,640 checking • $612 bills before payday • $744 buffer`

Do not expose the full calculation unless the user taps the card.

## Visual language

- Background: warm off-white / very light neutral.
- Cards: white with subtle border, not heavy shadows.
- Primary text: near-black.
- Secondary text: muted gray.
- One restrained accent color for positive/primary actions.
- Red/orange only for genuinely actionable problems.
- Rounded corners around 16–20px.
- Buttons are compact and calm; avoid oversized marketing-style CTAs.

## Bills screen

Top summary:

`$2,184 due this month`

Then a simple chronological list:

- Mortgage — Aug 15 — $1,900
- Electricity — Aug 18 — estimated $146
- Water — Aug 20 — $78
- Car — Aug 24 — $612

Each item can show a tiny source badge such as `Email`, `Bank`, or `Connected`.

## Spending screen

Show category totals and trend first. Transactions are secondary.

`Spent this month  $3,842`

Then 4–6 category cards. Tap a category to reveal transactions.

## Income screen

Lead with the next paycheck:

`Next paycheck  Aug 14`
`Expected $2,746`
`Confidence High`

Then a compact pay-period timeline showing timecard progress and forecast changes.

## Review queue

Automation should surface only things requiring human judgment:

- `New recurring charge found: Hulu — ~$19/mo`
- `Electric bill changed from $118 to $164`
- `Possible duplicate bill/payment`

Every review item gets one-tap actions: Confirm, Ignore, or Details.

## Avoid

- giant hero illustrations
- excessive gradients
- crypto/fintech-style neon colors
- spreadsheet-like home screen
- showing every transaction immediately
- forcing manual bill entry
- multiple competing primary buttons
