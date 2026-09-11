# Household finance brain

The app uses its existing Gemini integration for in-app questions and a daily saved check-in. ChatGPT Finances is an optional external advisor bridge; it is not automatically embedded in the app.

`src/engine/household-context.js` builds one interpretation for Home, Plan, monthly paycheck assignments, and advisor context. `web/household-data.js` shares a short-lived, user-scoped cache. Changes invalidate that cache. Daily analysis uses the same source modules copied into `_shared` by `npm run sync:shared`.

The calculation engine owns arithmetic. Posted transactions, provider identity, payment amount and due-date proximity establish payment matches. Early mortgage payments belong to the linked due month's bill; their cash movement remains on the actual transaction date. Ambiguous and partial payments stay open. Monthly records keep payment evidence separate from due dates.

Allowances cover the current paycheck window, including previous days' purchases, pending spending, and split children without counting their parent again. When no target exists, a clearly labeled starting suggestion uses spending in the 60 days before the period starts. Suggestions are not an affordability guarantee or a saved household agreement.

The paycheck timeline merges household income dates, advances recurring streams, and substitutes identifiable payroll evidence without removing a spouse's paycheck. Timecards are incomplete until payroll completion is independently verified. Missing or stale inputs remain visible. Imported payroll requires a unique employer match to avoid duplicate income.

The advisor explains evidence, proposes changes, and remembers explicit merchant corrections through existing shared rules. It cannot move money or silently execute model-generated writes. Daily notes are saved in-app, with no email dispatch. The daily job generates at most one successful note per household per UTC day; normal screen refreshes do not call the model.

Remaining extensions: persist an immutable invoice/payment-allocation ledger, split a large bill's funding across several checks, and expand the advisor's reviewed actions beyond merchant rules. Do not describe these as already implemented.
