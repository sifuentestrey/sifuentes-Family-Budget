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
2. Budget
3. Spending
4. Income
5. More

Desktop uses the same five sections in a compact left rail.

A tab that owns more than one screen carries a **segmented control** at the
top — Budget is Budget / Bills, Spending is Overview / Transactions, Income
is Overview / Paycheck / Shifts / Paystubs. Siblings are one tap apart and
visibly part of the same place.

"More" is settings and the genuinely peripheral, not an overflow list. An
earlier build put ten destinations there as ten identical rows, which is how
Trends, Paystubs and Connect all ended up equally buried.

## Density

One card per *list*, hairlines between rows — not a card per row. Twenty
separate cards is twenty borders, twenty shadows and twenty gaps of dead
space, which is most of what made a long list feel heavy. `.list.loose` is
the exception, for rows that carry their own buttons.

A transaction row is one line of payee, one line of date + category, and the
amount. The category reads as text and becomes a picker when tapped: it used
to be a `<select>` on every row, which put a 34px control on a line that
otherwise needs 40, nearly doubling the height of every transaction in the
app to offer a control almost nobody uses on almost any row.

Two things bite when working in here:

- Every `<summary>` gets a **negative margin** from the normalize stylesheet
  (to widen its tap target). Inside a card that makes the row 32px wider than
  its container and it spills out both sides. Set `margin: 0`.
- A `nowrap` title needs `min-width: 0` or it pushes its flex parent wider
  than the card.

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

## Visual language — "Signal"

Chosen by the household from three directions built as side-by-side mockups;
the other two were a hairline-and-serif "Ledger" and a dense dark "After Dark".
Worth knowing, because the temptation when adding a screen is to reach for
whatever looks good in isolation rather than for this:

- **Ground is soft grey** (`--bg`), and cards are **white and lifted off it**
  with a shadow — not outlined onto it with a border. In dark, the ground
  drops to near-black and cards lift above it the same way.
- **One dark hero card** per screen, carrying the single number that screen
  exists to answer. It is the only near-black surface in light mode, and the
  only raised one in dark. Nothing else on the screen competes with it.
- **Coral is the only saturated colour, and it means "this wants you"** — the
  active tab, a link, a category over its target, a primary button. Spending
  it on anything else is what makes an interface stop signalling.
- **Green is money coming in**, and nothing else. Income amounts, a target
  being kept to, a step already done.
- Type is **rounded and heavy** (SF Pro Rounded where available). Titles are
  700–800 weight with tight tracking; this is what stops it reading as a
  spreadsheet.
- Corners are round — 18px on cards, 22px on the hero, 11px on avatars.
- Amber/red stay reserved for genuinely actionable problems.
- Buttons are compact pills; avoid oversized marketing-style CTAs.

## Merchant logos

Rows show the merchant's own logo where one can be found, falling back to a
coloured initial. Three things about it are load-bearing:

- The domain is **derived from the payee** (`src/engine/merchant-domain.js`),
  because Plaid supplies a logo for only a minority of transactions. Wrong is
  worse than missing, so guessing refuses on a lone or generic word.
- Each logo has **two sources on different hosts**, tried in order. Either can
  404 for a site the other knows, and both are the kind of host a content
  blocker or filtering DNS blocks wholesale — which strips every logo at once
  and reads as a broken feature. A URL that fails is remembered for the
  session so re-renders don't re-request it.
- The **initial is the base layer** and the logo paints on top once loaded.
  A pending or blocked request therefore shows a normal row, never a blank
  plate. Never build this on swapping the img out on error: only a 404 fires
  an error event — a hang and a block do not.

## Budget screen

The plan for the month, in the two parts a household actually reasons about:

- **Bills** — known payee, known due date. Tracked bill records only.
- **Necessities** — groceries, gas, utilities, pharmacy. No due date, but the
  money goes out anyway. Each line shows spent against a target, and the
  target defaults to what this household actually spent in prior months, so
  the screen is useful before anybody has set a single number. Tap Edit to
  override one — targets are saved per household in `budget_targets`
  (migration 0018), behind the same RLS as everything else, so both people
  plan against the same numbers rather than each phone holding its own.

A category a tracked bill already covers is deliberately not repeated as a
necessity line — showing rent as both a bill and a category makes the month
look worse by exactly the rent. Subscriptions, Fitness and Savings are left
out too: the bucket model calls them committed because they charge the same
amount monthly, which is a statement about rhythm, not importance.

Discretionary spending is not budgeted here. It gets one line at the bottom
pointing at Spending.

See `src/engine/budget/monthly-budget.js`.

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

One question: what did we spend, and on what.

`Spent this month  $3,842`

Then the category cards, largest first. **Every category is tappable** and
opens the transactions behind it — a total nobody can drill into is a total
nobody believes. The same is true of "Where it went" on Home.

This screen used to open on a surplus figure over a
committed/necessary/discretionary/irregular table. That model still exists
and still feeds safe-to-spend, the buffer target and the plan — it just isn't
what someone opening Spending is asking about. Recurring and Trends moved to
More for the same reason: real screens, occasional destinations.

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
