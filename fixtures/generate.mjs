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
for (const date of alexPaydays) {
  transactions.push(
    txn('acc_checking_joint', date, -2184.62, 'DIRECT DEP NORTHSTAR LOGISTICS PAYROLL', {
      merchant: null,
      pfc: pfc('INCOME', 'INCOME_WAGES'),
    }),
  );
}

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
  ['acc_card_visa', '2026-07-08', 15.99, 'NETFLIX.COM', 'Netflix', pfc('ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO')],
  ['acc_card_visa', '2026-07-09', 11.99, 'PAYPAL *SPOTIFY USA', null, null],
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
  ['acc_card_visa', '2026-06-11', 15.99, 'NETFLIX.COM', null],
  ['acc_card_amex', '2026-06-12', 1240.00, 'BRIGHT HORIZONS CHILDCARE', pfc('GENERAL_SERVICES', 'GENERAL_SERVICES_CHILDCARE')],
  ['acc_checking_joint', '2026-06-14', 2350.00, 'RENT PAYMENT OAKWOOD PROPERTIES', pfc('RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT')],
  ['acc_card_visa', '2026-06-20', 39.85, 'TST* CHIPOTLE 2245', null],
];
for (const [account, date, amount, name, category] of june) {
  transactions.push(txn(account, date, amount, name, { pfc: category }));
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
