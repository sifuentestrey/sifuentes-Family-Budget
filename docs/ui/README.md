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

A tab that owns more than one screen carries a **segmented control** at the
top — Spending is Overview / Transactions / Recurring / Trends, Income is
Overview / Paycheck / Shifts / Paystubs. Siblings are one tap apart and
visibly part of the same place.

"More" is settings and the genuinely peripheral, not an overflow list. An
earlier build put ten destinations there as ten identical rows, which is how
Trends, Paystubs and Connect all ended up equally buried.

## Components

There is one of each, and views compose them rather than inventing their own —
this is what keeps the app from reading as several apps stapled together:

- `.hero` — the one number a screen exists to answer
- `.card` — a titled container
- `.row` — the single list row: avatar, title + chips, sub, amount, chevron,
  optional actions. Used for bills, transactions, subscriptions, income
  streams, shifts, paystubs, members and bank accounts alike.
- `.kv` — a labelled breakdown (calculation steps, totals)
- `.chip` — status and provenance badges
- `.btn` — one button scale: primary, secondary, outline, danger
- `.field` — one labelled input
- `.empty` — one empty state, with an action wherever there is one to offer

Icons are inline SVG at 1.6px stroke in `currentColor`, never emoji or unicode
glyphs — those render differently per platform and visibly are not from the
same family as each other.

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

Then the bills grouped by which paycheck has to cover each one, and below
that **Found in your transactions** — recurring charges the household is
already paying that are not tracked as bills yet, each with one-tap
`Track as bill` / `Not a bill`.

That section is the practical form of "never make the user manually enter a
bill that can be discovered automatically". The strongest evidence a bill
exists is that this account has already paid it, on a rhythm, for months — no
inbox to connect and no form to fill in. It only proposes, though: a recurring
charge is not automatically an obligation (a grocery run recurs too), and a
bill nobody confirmed would land in safe-to-spend as a commitment nobody
agreed to. See `src/engine/bill-suggestions.js` for what qualifies.

Each item shows a tiny source badge — `Email`, `Bank`, `Manual`.

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
