/**
 * Generate synthetic Plaid-shaped fixtures.
 *
 * Entirely invented data. Its job is to exercise the cases that break naive
 * budget tools, so the engine can be proven before a real bank is ever
 * connected:
 *
 *   - a credit card payment (transfer pair) that must not count as spending
 *   - a checking -> savings move (also a transfer)
 *   - two earners on DIFFERENT cadences: biweekly and semi-monthly
 *   - a three-paycheck month for the biweekly earner
 *   - messy real-world description strings the normalizer has to survive
 *   - a warehouse-club charge, the classic split candidate
 *
 * Run: node fixtures/generate.mjs > fixtures/sample-plaid.json
 */

const ACCOUNTS = [
  { account_id: 'acc_checking_joint', name: 'Joint Checking', type: 'depository', subtype: 'checking', mask: '4021' },
  { account_id: 'acc_savings_joint', name: 'Joint Savings', type: 'depository', subtype: 'savings', mask: '7788' },
  { account_id: 'acc_card_visa', name: 'Visa Everyday', type: 'credit', subtype: 'credit card', mask: '1043' },
  { account_id: 'acc_card_amex', name: 'Amex Blue', type: 'credit', subtype: 'credit card', mask: '2005' },
];

let seq = 0;
function txn(account_id, date, amount, name, opts = {}) {
  return {
    transaction_id: `txn_${String(++seq).padStart(4, '0')}`,
    account_id,
    date,
    amount,
    name,
    merchant_name: opts.merchant ?? null,
    original_description: opts.original ?? name,
    personal_finance_category: opts.pfc ?? null,
    pending: opts.pending ?? false,
  };
}

const pfc = (primary, detailed) => ({ primary, detailed });
const transactions = [];

// ---------------------------------------------------------------------------
// Income: two earners, two different cadences.
//
// Alex is biweekly (every 14 days). July 2026 is the three-paycheck month —
// deposits on the 3rd, 17th, AND 31st. Sam is semi-monthly (1st and 15th),
// always exactly two. This pairing is the most common real-world case and the
// one that makes "monthly income" a meaningless number.
// ---------------------------------------------------------------------------
const alexPaydays = [
  '2026-05-08', '2026-05-22', '2026-06-05', '2026-06-19',
  '2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14',
];
// Alex works call shifts, so the AMOUNT varies every check while the cadence
// stays rigidly biweekly. This is the case that breaks a median-based model:
// the median is ~$2,180 but checks range $1,412-$3,104. A budget built on the
// median is unaffordable in roughly half of all pay periods.
//
// Paired with the dates above so July still contains three paychecks — a
// three-paycheck month AND variable amounts interacting is the realistic case.
const alexAmounts = [
  2284.15,  // 05-08
  1412.88,  // 05-22  slow stretch — the floor case
  2611.40,  // 06-05
  1876.22,  // 06-19
  3104.67,  // 07-03  heavy call week
  2043.91,  // 07-17
  2455.30,  // 07-31  third paycheck in July
  1689.75,  // 08-14
];
alexPaydays.forEach((date, i) => {
  transactions.push(
    txn('acc_checking_joint', date, -alexAmounts[i], 'DIRECT DEP NORTHSTAR LOGISTICS PAYROLL', {
      merchant: null,
      pfc: pfc('INCOME', 'INCOME_WAGES'),
    }),
  );
});

const samPaydays = [
  '2026-05-01', '2026-05-15', '2026-06-01', '2026-06-15',
  '2026-07-01', '2026-07-15', '2026-08-01',
];
for (const date of samPaydays) {
  transactions.push(
    txn('acc_checking_joint', date, -1912.40, 'ACH CREDIT MERIDIAN HEALTH GRP DIRDEP', {
      pfc: pfc('INCOME', 'INCOME_WAGES'),
    }),
  );
}

// ---------------------------------------------------------------------------
// THE CRITICAL CASE: credit card payments.
//
// Money leaves checking (+) and the card balance drops (-). Neither is
// spending; the spending already happened at each swipe. Counting the payment
// would inflate July spend by $1,450 — more than the household's entire
// grocery budget.
//
// Note the two sides post a day apart and carry totally different descriptions,
// which is why detection matches on amount + window rather than on text.
// ---------------------------------------------------------------------------
transactions.push(
  txn('acc_checking_joint', '2026-07-05', 1450.00, 'CHASE CREDIT CRD AUTOPAY 072026'),
  txn('acc_card_visa', '2026-07-06', -1450.00, 'PAYMENT THANK YOU - WEB'),
  txn('acc_checking_joint', '2026-06-05', 1102.35, 'CHASE CREDIT CRD AUTOPAY 062026'),
  txn('acc_card_visa', '2026-06-06', -1102.35, 'PAYMENT THANK YOU - WEB'),
);

// Checking -> savings. Saving, not spending.
transactions.push(
  txn('acc_checking_joint', '2026-07-06', 800.00, 'ONLINE TRANSFER TO SAVINGS 7788'),
  txn('acc_savings_joint', '2026-07-06', -800.00, 'ONLINE TRANSFER FROM CHECKING 4021'),
);

// An Amex payment whose counterpart account is NOT linked. Unpaired, but the
// keyword hint still keeps it out of spending.
transactions.push(
  txn('acc_checking_joint', '2026-07-12', 640.18, 'AMEX EPAYMENT ACH PMT'),
);

// ---------------------------------------------------------------------------
// Everyday spending, with deliberately messy descriptions.
// ---------------------------------------------------------------------------
const spending = [
  // [account, date, amount, name, merchant_name, pfc]
  ['acc_card_visa', '2026-07-02', 142.87, 'SAFEWAY #1234 SAN FRANCISCO CA', null, pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')],
  ['acc_card_visa', '2026-07-03', 6.75, 'SQ *BLUE BOTTLE COFFEE #4412 OAKLAND CA', null, null],
  ['acc_card_visa', '2026-07-04', 23.41, 'TST* CHIPOTLE 2245', null, pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD')],
  ['acc_card_visa', '2026-07-06', 58.20, 'SHELL OIL 57445123456', 'Shell', pfc('TRANSPORTATION', 'TRANSPORTATION_GAS')],
  ['acc_card_visa', '2026-07-07', 312.44, 'COSTCO WHSE #0472 SEATTLE WA', null, null],
  ['acc_card_visa', '2026-07-10', 87.33, 'AMZN Mktp US*RT4G59DK3', null, pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES')],
  ['acc_card_visa', '2026-07-11', 44.10, 'POS DEBIT 07/11 TRADER JOES #123', null, null],
  ['acc_card_amex', '2026-07-12', 1240.00, 'BRIGHT HORIZONS CHILDCARE', null, pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_CHILDCARE')],
  ['acc_card_amex', '2026-07-13', 68.45, 'CVS/PHARMACY #08812 BERKELEY CA', null, pfc('MEDICAL', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS')],
  ['acc_checking_joint', '2026-07-14', 2350.00, 'RENT PAYMENT OAKWOOD PROPERTIES', null, pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT')],
  ['acc_checking_joint', '2026-07-15', 187.62, 'ACH DEBIT PG&E WEB ONLINE', null, pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY')],
  ['acc_checking_joint', '2026-07-16', 94.99, 'COMCAST XFINITY WEB PMT', null, null],
  ['acc_card_visa', '2026-07-17', 32.18, 'UBER TRIP 8KJ2N', 'Uber', pfc('TRANSPORTATION', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES')],
  ['acc_card_visa', '2026-07-18', 129.99, 'REI #0021 SEATTLE WA', null, null],
  ['acc_card_amex', '2026-07-19', 76.30, 'WHOLE FOODS MKT #10234', null, pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')],
  ['acc_card_visa', '2026-07-20', 18.50, 'VENMO *JORDAN ELLIS', null, null],
  ['acc_card_visa', '2026-07-22', 245.00, 'GEICO AUTO INSURANCE', 'Geico', pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE')],
  ['acc_card_amex', '2026-07-24', 62.14, 'PETCO #1882', null, pfc('GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_PET_SUPPLIES')],
  // A payee no rule and no PFC will catch — must land in the review queue, not
  // be silently guessed at.
  ['acc_card_visa', '2026-07-25', 89.00, 'HRTLND PMT SYS MRCH SVC 449201', null, null],
  ['acc_card_visa', '2026-07-26', 210.75, 'BAY AREA ORTHODONTICS', null, pfc('MEDICAL', 'MEDICAL_DENTAL_CARE')],
  ['acc_checking_joint', '2026-07-28', 35.00, 'INTEREST CHARGE ON PURCHASES', null, pfc('BANK_FEES', 'BANK_FEES_INTEREST_CHARGE')],
  // Pending: must be excluded from totals until it posts.
  ['acc_card_visa', '2026-08-05', 51.20, 'SQ *PHILZ COFFEE', null, null],
];

for (const [account, date, amount, name, merchant, category] of spending) {
  transactions.push(
    txn(account, date, amount, name, {
      merchant,
      pfc: category,
      pending: date === '2026-08-05',
    }),
  );
}

// June spending, so trends have a prior month to compare against.
const june = [
  ['acc_card_visa', '2026-06-03', 128.40, 'SAFEWAY #1234 SAN FRANCISCO CA', pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')],
  ['acc_card_visa', '2026-06-09', 61.10, 'SHELL OIL 57445123456', pfc('TRANSPORTATION', 'TRANSPORTATION_GAS')],
  ['acc_card_amex', '2026-06-12', 1240.00, 'BRIGHT HORIZONS CHILDCARE', pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_CHILDCARE')],
  ['acc_checking_joint', '2026-06-14', 2350.00, 'RENT PAYMENT OAKWOOD PROPERTIES', pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT')],
  ['acc_card_visa', '2026-06-20', 39.85, 'TST* CHIPOTLE 2245', null],
];
for (const [account, date, amount, name, category] of june) {
  transactions.push(txn(account, date, amount, name, { pfc: category }));
}

// ---------------------------------------------------------------------------
// Recurring subscriptions, spanning enough months to be detectable.
//
// Includes the cases that matter:
//   - a PRICE INCREASE mid-history (Netflix 15.99 -> 17.99). Must be recognized
//     as one stream that got more expensive, not two separate subscriptions.
//   - DUPLICATE SERVICES (Spotify + Apple Music) in the same category.
//   - a FORGOTTEN subscription (gym, charged monthly, no related activity).
//   - an ANNUAL premium, the sinking-fund case that breaks budgets in month four.
// ---------------------------------------------------------------------------
const subscriptionMonths = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

// Netflix raises its price from June onward.
for (const month of subscriptionMonths) {
  const amount = month >= '2026-06' ? 17.99 : 15.99;
  transactions.push(
    txn('acc_card_visa', `${month}-08`, amount, 'NETFLIX.COM', {
      merchant: 'Netflix',
      pfc: pfc('ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO'),
    }),
  );
}

for (const month of subscriptionMonths) {
  transactions.push(
    txn('acc_card_visa', `${month}-09`, 11.99, 'PAYPAL *SPOTIFY USA'),
    // Second music service — the household is paying twice for the same thing.
    txn('acc_card_amex', `${month}-21`, 10.99, 'APPLE.COM/BILL APPLE MUSIC', {
      merchant: 'Apple Music',
    }),
    // Charged every month, never any adjacent activity. The classic forgotten one.
    txn('acc_card_amex', `${month}-03`, 49.00, 'PLANET FITNESS MEMBERSHIP', {
      pfc: pfc('PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'),
    }),
  );
}

// Annual auto insurance premium. Lands once, for ~6x a monthly bill. Without a
// sinking fund this is the month the budget breaks.
transactions.push(
  txn('acc_checking_joint', '2026-04-18', 1428.00, 'GEICO AUTO INSURANCE ANNUAL PREMIUM', {
    merchant: 'Geico',
    pfc: pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE'),
  }),
);

// Monthly childcare across the history, so it reads as committed rather than
// a one-off. Already the household's second largest expense after rent.
for (const month of ['2026-03', '2026-04', '2026-05']) {
  transactions.push(
    txn('acc_card_amex', `${month}-12`, 1240.00, 'BRIGHT HORIZONS CHILDCARE', {
      pfc: pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_CHILDCARE'),
    }),
  );
}

// Rent, the largest committed expense, across the same window.
for (const month of ['2026-03', '2026-04', '2026-05']) {
  transactions.push(
    txn('acc_checking_joint', `${month}-14`, 2350.00, 'RENT PAYMENT OAKWOOD PROPERTIES', {
      pfc: pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT'),
    }),
  );
}

// Everyday necessities across the earlier months too.
//
// Without these, March-May contain only rent and subscriptions, and the engine
// correctly-but-uselessly concludes the household buys groceries in 2 months
// out of 5. Real Plaid history is complete, so a fixture with truncated months
// tests the wrong thing. Amounts vary month to month, as they genuinely do.
const earlyNecessities = {
  '2026-03': { groceries: [131.20, 96.44, 118.75], gas: [54.10, 47.85], utilities: 172.40, internet: 94.99 },
  '2026-04': { groceries: [142.05, 88.30, 109.61], gas: [61.22, 52.40], utilities: 168.95, internet: 94.99 },
  '2026-05': { groceries: [127.88, 103.16, 134.42], gas: [49.77, 58.03], utilities: 181.20, internet: 94.99 },
};

for (const [month, items] of Object.entries(earlyNecessities)) {
  items.groceries.forEach((amount, i) => {
    transactions.push(
      txn('acc_card_visa', `${month}-${String(5 + i * 9).padStart(2, '0')}`, amount,
        'SAFEWAY #1234 SAN FRANCISCO CA', {
          pfc: pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'),
        }),
    );
  });
  items.gas.forEach((amount, i) => {
    transactions.push(
      txn('acc_card_visa', `${month}-${String(7 + i * 14).padStart(2, '0')}`, amount,
        'SHELL OIL 57445123456', { merchant: 'Shell', pfc: pfc('TRANSPORTATION', 'TRANSPORTATION_GAS') }),
    );
  });
  transactions.push(
    txn('acc_checking_joint', `${month}-15`, items.utilities, 'ACH DEBIT PG&E WEB ONLINE', {
      pfc: pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'),
    }),
    txn('acc_checking_joint', `${month}-16`, items.internet, 'COMCAST XFINITY WEB PMT'),
    // Some discretionary spending, so the bucket isn't artificially empty.
    txn('acc_card_visa', `${month}-19`, 38.50 + Number(month.slice(-1)) * 3, 'TST* CHIPOTLE 2245', {
      pfc: pfc('FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD'),
    }),
  );
}

const output = {
  _comment:
    'SYNTHETIC DATA. Entirely invented — no real accounts, people, or amounts. ' +
    'Exercises transfer pairing, mixed pay cadences including a three-paycheck ' +
    'month, messy descriptions, pending exclusion, and an uncategorizable payee.',
  accounts: ACCOUNTS,
  transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
};

console.log(JSON.stringify(output, null, 2));
