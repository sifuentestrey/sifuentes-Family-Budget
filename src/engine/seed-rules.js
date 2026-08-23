/**
 * Default categories and seed keyword rules.
 *
 * These are a starting point, not a fixed taxonomy. Every household's spending
 * has idiosyncrasies no default list can anticipate, which is why the learned
 * layer outranks these: the first time a category is corrected, that decision
 * wins permanently.
 *
 * Category kinds:
 *   fixed    - same amount monthly (rent, insurance)
 *   variable - fluctuates (groceries, gas)
 *   sinking  - irregular, saved toward monthly. Sinking funds are what separate
 *              a budget that survives from one that blows up in month four,
 *              when the annual insurance premium lands.
 */

export const SEED_CATEGORIES = [
  // group, name, kind, note
  ['Housing', 'Rent/Mortgage', 'fixed'],
  ['Housing', 'Utilities', 'fixed'],
  ['Housing', 'Internet/Phone', 'fixed'],
  ['Housing', 'Home Maintenance', 'sinking'],

  ['Food', 'Groceries', 'variable'],
  ['Food', 'Dining Out', 'variable'],
  ['Food', 'Coffee', 'variable'],

  ['Transport', 'Gas', 'variable'],
  ['Transport', 'Car Payment', 'fixed'],
  ['Transport', 'Car Insurance', 'fixed'],
  ['Transport', 'Car Maintenance', 'sinking'],
  ['Transport', 'Registration/Fees', 'sinking'],
  ['Transport', 'Parking/Transit', 'variable'],

  ['Health', 'Medical', 'variable'],
  ['Health', 'Pharmacy', 'variable'],
  ['Health', 'Health Insurance', 'fixed'],
  ['Health', 'Fitness', 'fixed'],

  ['Family', 'Childcare', 'fixed'],
  ['Family', 'Kids Supplies', 'variable'],
  ['Family', 'Pets', 'variable'],

  ['Personal', 'Shopping', 'variable'],
  ['Personal', 'Clothing', 'variable'],
  ['Personal', 'Personal Care', 'variable'],
  ['Personal', 'Gifts', 'sinking'],

  ['Lifestyle', 'Subscriptions', 'fixed'],
  ['Lifestyle', 'Entertainment', 'variable'],
  ['Lifestyle', 'Travel', 'sinking'],
  ['Lifestyle', 'Hobbies', 'variable'],

  ['Financial', 'Insurance', 'fixed'],
  ['Financial', 'Taxes', 'sinking'],
  ['Financial', 'Fees/Interest', 'variable'],
  ['Financial', 'Savings', 'fixed'],

  ['Income', 'Paycheck', 'income'],
  ['Income', 'Other Income', 'income'],

  ['Transfer', 'Transfer', 'transfer'],
  ['Other', 'Uncategorized', 'variable'],
];

/**
 * Keyword rules, matched against the cleaned payee (case-insensitive substring).
 *
 * Ordering note: more specific patterns must come first. "WHOLE FOODS" has to
 * be matched before a generic "FOOD" pattern would catch it, so specificity
 * drives the priority number rather than alphabetical or thematic grouping.
 */
export const SEED_RULES = [
  // --- Groceries ---
  ['whole foods', 'Groceries'], ['trader joe', 'Groceries'],
  ['safeway', 'Groceries'], ['kroger', 'Groceries'], ['albertsons', 'Groceries'],
  ['publix', 'Groceries'], ['aldi', 'Groceries'], ['wegmans', 'Groceries'],
  ['sprouts', 'Groceries'], ['h-e-b', 'Groceries'], ['heb', 'Groceries'],
  ['food lion', 'Groceries'], ['giant', 'Groceries'], ['meijer', 'Groceries'],
  ['ralphs', 'Groceries'], ['vons', 'Groceries'], ['stop & shop', 'Groceries'],
  ['winco', 'Groceries'], ['fred meyer', 'Groceries'], ['grocery', 'Groceries'],
  ['instacart', 'Groceries'],

  // --- Warehouse clubs: default to Groceries, but these are prime split
  //     candidates — a Costco run is groceries AND household goods.
  ['costco', 'Groceries'], ['sams club', 'Groceries'], ['bjs wholesale', 'Groceries'],

  // --- Coffee ---
  ['starbucks', 'Coffee'], ['peets', 'Coffee'], ['blue bottle', 'Coffee'],
  ['dunkin', 'Coffee'], ['philz', 'Coffee'], ['coffee', 'Coffee'],
  ['cafe', 'Coffee'], ['espresso', 'Coffee'],

  // --- Dining ---
  ['chipotle', 'Dining Out'], ['mcdonald', 'Dining Out'], ['taco bell', 'Dining Out'],
  ['kfc', 'Dining Out'], ['kentucky fried chicken', 'Dining Out'],
  ['papa john', 'Dining Out'],
  ['subway', 'Dining Out'], ['panera', 'Dining Out'], ['chick-fil-a', 'Dining Out'],
  ['chick fil a', 'Dining Out'], ['wendys', 'Dining Out'], ['burger king', 'Dining Out'],
  ['pizza', 'Dining Out'], ['sushi', 'Dining Out'], ['restaurant', 'Dining Out'],
  ['doordash', 'Dining Out'], ['grubhub', 'Dining Out'], ['uber eats', 'Dining Out'],
  ['ubereats', 'Dining Out'], ['postmates', 'Dining Out'], ['seamless', 'Dining Out'],
  ['taqueria', 'Dining Out'], ['grill', 'Dining Out'], ['kitchen', 'Dining Out'],
  ['bakery', 'Dining Out'], ['deli', 'Dining Out'], ['bar &', 'Dining Out'],

  // --- Gas ---
  ['shell', 'Gas'], ['chevron', 'Gas'], ['exxon', 'Gas'], ['mobil', 'Gas'],
  ['arco', 'Gas'], ['valero', 'Gas'], ['texaco', 'Gas'], ['sunoco', 'Gas'],
  ['citgo', 'Gas'], ['marathon', 'Gas'], ['speedway', 'Gas'], ['wawa', 'Gas'],
  ['quiktrip', 'Gas'], ['racetrac', 'Gas'], ['circle k', 'Gas'], ['76 ', 'Gas'],
  ['fuel', 'Gas'], ['gasoline', 'Gas'],

  // --- Transit / parking ---
  ['uber', 'Parking/Transit'], ['lyft', 'Parking/Transit'],
  ['parking', 'Parking/Transit'], ['metro', 'Parking/Transit'],
  ['transit', 'Parking/Transit'], ['bart', 'Parking/Transit'],
  ['toll', 'Parking/Transit'], ['fastrak', 'Parking/Transit'],
  ['amtrak', 'Parking/Transit'],

  // --- Utilities ---
  ['pg&e', 'Utilities'], ['edison', 'Utilities'], ['duke energy', 'Utilities'],
  ['con edison', 'Utilities'], ['national grid', 'Utilities'],
  ['water', 'Utilities'], ['electric', 'Utilities'], ['gas company', 'Utilities'],
  ['waste management', 'Utilities'], ['recology', 'Utilities'],
  ['sewer', 'Utilities'], ['utility', 'Utilities'],

  // --- Internet / phone ---
  ['comcast', 'Internet/Phone'], ['xfinity', 'Internet/Phone'],
  ['at&t', 'Internet/Phone'], ['verizon', 'Internet/Phone'],
  ['t-mobile', 'Internet/Phone'], ['tmobile', 'Internet/Phone'],
  ['spectrum', 'Internet/Phone'], ['centurylink', 'Internet/Phone'],
  ['google fi', 'Internet/Phone'], ['mint mobile', 'Internet/Phone'],

  // --- Subscriptions ---
  ['netflix', 'Subscriptions'], ['spotify', 'Subscriptions'],
  ['hulu', 'Subscriptions'], ['disney', 'Subscriptions'],
  ['hbo', 'Subscriptions'], ['max.com', 'Subscriptions'],
  ['apple.com/bill', 'Subscriptions'], ['apple services', 'Subscriptions'],
  // cleanPayee strips ".com", so the bare merchant names must match too.
  ['apple music', 'Subscriptions'], ['apple tv', 'Subscriptions'],
  ['sirius', 'Subscriptions'], ['pandora', 'Subscriptions'],
  ['tidal', 'Subscriptions'], ['crunchyroll', 'Subscriptions'],
  ['nytimes', 'Subscriptions'], ['new york times', 'Subscriptions'],
  ['chatgpt', 'Subscriptions'], ['openai', 'Subscriptions'],
  ['anthropic', 'Subscriptions'], ['claude.ai', 'Subscriptions'],
  ['github', 'Subscriptions'], ['notion', 'Subscriptions'],
  ['google storage', 'Subscriptions'], ['youtube', 'Subscriptions'],
  ['audible', 'Subscriptions'], ['patreon', 'Subscriptions'],
  ['adobe', 'Subscriptions'], ['dropbox', 'Subscriptions'],
  ['paramount', 'Subscriptions'], ['peacock', 'Subscriptions'],
  ['prime video', 'Subscriptions'], ['icloud', 'Subscriptions'],

  // --- Fitness ---
  ['planet fitness', 'Fitness'], ['equinox', 'Fitness'], ['24 hour fitness', 'Fitness'],
  ['gym', 'Fitness'], ['yoga', 'Fitness'], ['peloton', 'Fitness'],
  ['crossfit', 'Fitness'], ['lifetime fitness', 'Fitness'],

  // --- Pharmacy / medical ---
  ['cvs', 'Pharmacy'], ['walgreens', 'Pharmacy'], ['rite aid', 'Pharmacy'],
  ['pharmacy', 'Pharmacy'], ['dental', 'Medical'], ['dentist', 'Medical'],
  ['clinic', 'Medical'], ['medical', 'Medical'], ['hospital', 'Medical'],
  ['physician', 'Medical'], ['optometry', 'Medical'], ['urgent care', 'Medical'],
  ['labcorp', 'Medical'], ['quest diagnostics', 'Medical'],

  // --- Family ---
  ['daycare', 'Childcare'], ['preschool', 'Childcare'], ['childcare', 'Childcare'],
  ['kindercare', 'Childcare'], ['babysit', 'Childcare'], ['montessori', 'Childcare'],
  ['bright horizons', 'Childcare'],
  ['buybuy baby', 'Kids Supplies'], ['carters', 'Kids Supplies'],
  ['petco', 'Pets'], ['petsmart', 'Pets'], ['chewy', 'Pets'],
  ['veterinary', 'Pets'], ['vet clinic', 'Pets'],

  // --- Shopping ---
  ['amazon', 'Shopping'], ['target', 'Shopping'], ['walmart', 'Shopping'],
  ['ikea', 'Shopping'], ['home depot', 'Home Maintenance'],
  ['lowes', 'Home Maintenance'], ['ace hardware', 'Home Maintenance'],
  ['best buy', 'Shopping'], ['etsy', 'Shopping'], ['ebay', 'Shopping'],
  ['wayfair', 'Shopping'], ['nordstrom', 'Clothing'], ['macys', 'Clothing'],
  ['old navy', 'Clothing'], ['gap ', 'Clothing'], ['h&m', 'Clothing'],
  ['uniqlo', 'Clothing'], ['zara', 'Clothing'], ['nike', 'Clothing'],
  ['lululemon', 'Clothing'], ['rei', 'Hobbies'],

  // --- Personal care ---
  ['salon', 'Personal Care'], ['barber', 'Personal Care'],
  ['sephora', 'Personal Care'], ['ulta', 'Personal Care'], ['spa', 'Personal Care'],

  // --- Entertainment / travel ---
  ['cinema', 'Entertainment'], ['amc ', 'Entertainment'], ['regal', 'Entertainment'],
  ['theatre', 'Entertainment'], ['theater', 'Entertainment'],
  ['ticketmaster', 'Entertainment'], ['stubhub', 'Entertainment'],
  ['steam games', 'Hobbies'], ['nintendo', 'Hobbies'], ['playstation', 'Hobbies'],
  ['airbnb', 'Travel'], ['expedia', 'Travel'], ['booking.com', 'Travel'],
  ['marriott', 'Travel'], ['hilton', 'Travel'], ['hyatt', 'Travel'],
  ['airlines', 'Travel'], ['delta air', 'Travel'], ['united air', 'Travel'],
  ['southwest air', 'Travel'], ['alaska air', 'Travel'], ['hotel', 'Travel'],

  // --- Financial ---
  ['geico', 'Car Insurance'], ['state farm', 'Insurance'],
  ['progressive', 'Car Insurance'], ['allstate', 'Insurance'],
  ['usaa', 'Insurance'], ['dmv', 'Registration/Fees'],
  ['irs', 'Taxes'], ['franchise tax', 'Taxes'],
  ['interest charge', 'Fees/Interest'], ['annual fee', 'Fees/Interest'],
  ['overdraft', 'Fees/Interest'], ['late fee', 'Fees/Interest'],
  ['atm fee', 'Fees/Interest'], ['foreign transaction', 'Fees/Interest'],
];

/**
 * Plaid's Personal Finance Category taxonomy mapped onto ours.
 * Plaid ships a category with every transaction, derived from their own models
 * over enormous transaction volume — free ML we would otherwise have to buy.
 * Keyed on PFC `primary`; `detailed` is checked first where it adds precision.
 */
export const PFC_DETAILED_MAP = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  FOOD_AND_DRINK_RESTAURANT: 'Dining Out',
  FOOD_AND_DRINK_FAST_FOOD: 'Dining Out',
  FOOD_AND_DRINK_COFFEE: 'Coffee',
  TRANSPORTATION_GAS: 'Gas',
  TRANSPORTATION_PARKING: 'Parking/Transit',
  TRANSPORTATION_PUBLIC_TRANSIT: 'Parking/Transit',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'Parking/Transit',
  TRANSPORTATION_TOLLS: 'Parking/Transit',
  LOAN_PAYMENTS_CAR_PAYMENT: 'Car Payment',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'Rent/Mortgage',
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: 'Fees/Interest',
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: 'Fees/Interest',
  LOAN_PAYMENTS_OTHER_PAYMENT: 'Fees/Interest',
  RENT_AND_UTILITIES_RENT: 'Rent/Mortgage',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'Internet/Phone',
  RENT_AND_UTILITIES_TELEPHONE: 'Internet/Phone',
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'Utilities',
  RENT_AND_UTILITIES_WATER: 'Utilities',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: 'Utilities',
  MEDICAL_PRIMARY_CARE: 'Medical',
  MEDICAL_DENTAL_CARE: 'Medical',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'Pharmacy',
  MEDICAL_EYE_CARE: 'Medical',
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'Fitness',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'Personal Care',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'Clothing',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'Pets',
  GENERAL_MERCHANDISE_ELECTRONICS: 'Shopping',
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: 'Shopping',
  GENERAL_SERVICES_INSURANCE: 'Insurance',
  GENERAL_SERVICES_CHILDCARE: 'Childcare',
  HOME_IMPROVEMENT_HARDWARE: 'Home Maintenance',
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: 'Home Maintenance',
  ENTERTAINMENT_MOVIES_AND_TV: 'Entertainment',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'Subscriptions',
  ENTERTAINMENT_SPORTING_EVENTS: 'Entertainment',
  ENTERTAINMENT_VIDEO_GAMES: 'Hobbies',
  TRAVEL_FLIGHTS: 'Travel',
  TRAVEL_LODGING: 'Travel',
  BANK_FEES_OVERDRAFT_FEES: 'Fees/Interest',
  BANK_FEES_INTEREST_CHARGE: 'Fees/Interest',
  BANK_FEES_ATM_FEES: 'Fees/Interest',
  BANK_FEES_FOREIGN_TRANSACTION_FEES: 'Fees/Interest',
  INCOME_WAGES: 'Paycheck',
  INCOME_OTHER_INCOME: 'Other Income',
};

export const PFC_PRIMARY_MAP = {
  FOOD_AND_DRINK: 'Dining Out',
  TRANSPORTATION: 'Parking/Transit',
  RENT_AND_UTILITIES: 'Utilities',
  MEDICAL: 'Medical',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Home Maintenance',
  ENTERTAINMENT: 'Entertainment',
  TRAVEL: 'Travel',
  BANK_FEES: 'Fees/Interest',
  GENERAL_SERVICES: 'Shopping',
  GOVERNMENT_AND_NON_PROFIT: 'Taxes',
  INCOME: 'Other Income',
  // Deliberately absent: LOAN_PAYMENTS. It covers a car loan, a student loan,
  // a mortgage and a credit card payment, and mapping the whole primary to
  // 'Car Payment' filed all four as a car payment. The detailed values below
  // name the ones we can place; the rest go to the review queue, which is the
  // honest outcome for "some loan, we don't know which".
};
