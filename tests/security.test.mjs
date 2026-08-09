/**
 * Security guardrails, enforced as tests so they fail loudly rather than
 * relying on anyone remembering.
 *
 * These check the things that would be genuinely damaging to get wrong:
 * credentials reaching the repo or the browser, real financial data becoming
 * committable, and the database being readable outside the household.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', '.git', 'data'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const allFiles = walk(ROOT);
const sourceFiles = allFiles.filter((f) => /\.(js|mjs|ts|html|json|sql)$/.test(f));

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test('no live credentials committed anywhere', () => {
  // Patterns for real secrets. Deliberately narrow — matching the *word*
  // "secret" would flag every legitimate mention in docs and code.
  const patterns = [
    [/\bsk_live_[A-Za-z0-9]{8,}/, 'Stripe live key'],
    [/\baccess-(sandbox|development|production)-[0-9a-f-]{20,}/, 'Plaid access token'],
    [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'JWT'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
    [/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, 'private key'],
  ];

  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8');
    for (const [pattern, label] of patterns) {
      assert.ok(
        !pattern.test(content),
        `${label} found in ${file.replace(ROOT, '')}`,
      );
    }
  }
});

test('Plaid credentials are read from the environment, never literals', () => {
  const sync = readFileSync(join(ROOT, 'supabase/functions/sync-transactions/index.ts'), 'utf8');
  assert.match(sync, /Deno\.env\.get\('PLAID_CLIENT_ID'\)/);
  assert.match(sync, /Deno\.env\.get\('PLAID_SECRET'\)/);
  // An assignment of a quoted literal to a credential name would mean a
  // hardcoded value.
  assert.doesNotMatch(sync, /PLAID_SECRET\s*[:=]\s*['"][^'"]+['"]/);
});

test('the browser bundle never touches tokens or the service role', () => {
  // Anything in web/ ships to the client. A service-role key there would grant
  // every visitor full database access, bypassing RLS entirely.
  for (const file of walk(join(ROOT, 'web'))) {
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /SERVICE_ROLE/i, `service role referenced in ${file}`);
    assert.doesNotMatch(content, /access_token/i, `access token referenced in ${file}`);
    assert.doesNotMatch(content, /PLAID_SECRET/i, `Plaid secret referenced in ${file}`);
  }
});

// ---------------------------------------------------------------------------
// Real data cannot be committed
// ---------------------------------------------------------------------------

test('gitignore blocks secrets and every common statement format', () => {
  const paths = [
    '.env',
    '.env.local',
    'data/statements.csv',
    'data/real-transactions.json',
    'export.csv',
    'statement.pdf',
    'accounts.xlsx',
    'transactions.ofx',
  ];

  for (const path of paths) {
    const ignored = execSync(`git check-ignore -q "${path}" && echo yes || echo no`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    assert.equal(ignored, 'yes', `${path} is NOT gitignored — real data could be committed`);
  }
});

test('no real financial data is tracked in git', () => {
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n');
  const dangerous = tracked.filter((f) => /\.(csv|pdf|xlsx|ofx|qfx)$/.test(f));
  assert.deepEqual(dangerous, [], 'statement-format files are tracked');
});

test('fixtures are labelled synthetic', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'fixtures/sample-plaid.json'), 'utf8'));
  assert.match(
    fixture._comment,
    /SYNTHETIC/i,
    'fixtures must be self-identifying so nobody mistakes them for real data',
  );
});

// ---------------------------------------------------------------------------
// Database access control
// ---------------------------------------------------------------------------

const schema = readFileSync(join(ROOT, 'supabase/migrations/0001_init.sql'), 'utf8');

test('every household table has RLS enabled', () => {
  const tables = [
    'households', 'household_members', 'items', 'accounts',
    'categories', 'rules', 'transactions', 'income_streams', 'sync_log',
  ];
  for (const table of tables) {
    assert.match(
      schema,
      new RegExp(`alter table ${table}\\s+enable row level security`, 'i'),
      `RLS not enabled on ${table}`,
    );
  }
});

test('every RLS policy scopes to the current household', () => {
  const policies = schema.match(/create policy[\s\S]*?;/gi) ?? [];
  assert.ok(policies.length >= 9, 'expected a policy per table');
  for (const policy of policies) {
    assert.match(
      policy,
      /current_household_ids\(\)/,
      `policy does not scope by household: ${policy.slice(0, 60)}`,
    );
  }
});

test('access tokens are not stored in a queryable column', () => {
  // items.token_ref holds a Vault lookup key, not the token. A token in a
  // regular column lands in every backup and every `select *`.
  const itemsTable = schema.match(/create table items[\s\S]*?\);/i)[0];
  assert.doesNotMatch(itemsTable, /access_token\s+text/i, 'token stored directly on items');
  assert.match(itemsTable, /token_ref/);
});

test('vault functions are revoked from client-facing roles', () => {
  const vault = readFileSync(join(ROOT, 'supabase/migrations/0002_vault_and_cron.sql'), 'utf8');
  assert.match(vault, /revoke all on function read_vault_secret\(text\) from public, anon, authenticated/i);
  assert.match(vault, /grant execute on function read_vault_secret\(text\) to service_role/i);
});

test('Plaid is never requested with money-movement scope', () => {
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf8');
    // 'transfer' appears legitimately (transfer detection), so match only the
    // Plaid product declaration form.
    assert.doesNotMatch(
      content,
      /products['"]?\s*:\s*\[[^\]]*['"]transfer['"]/i,
      `Plaid transfer product requested in ${file.replace(ROOT, '')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Bills and payroll schema (0003) — same guarantees as the original tables
// ---------------------------------------------------------------------------

const billsSchema = readFileSync(join(ROOT, 'supabase/migrations/0003_bills_and_payroll.sql'), 'utf8');
const viewSecurity = readFileSync(join(ROOT, 'supabase/migrations/0004_view_security.sql'), 'utf8');

test('every bills/payroll table has RLS enabled', () => {
  const tables = [
    'provider_connections', 'sync_runs', 'bill_sources', 'bills', 'bill_imports',
    'bill_payments', 'pay_profiles', 'pay_periods', 'time_entries',
    'paycheck_forecasts', 'paystubs', 'deductions', 'paycheck_reconciliations',
    'income_sources',
  ];
  for (const table of tables) {
    assert.match(
      billsSchema,
      new RegExp(`alter table ${table}\\s+enable row level security`, 'i'),
      `RLS not enabled on ${table}`,
    );
    assert.match(
      billsSchema,
      new RegExp(`create policy \\w+ on ${table}\\b`, 'i'),
      `no policy for ${table}`,
    );
  }
});

test('views run as the querying user, not their owner', () => {
  // A view owned by postgres bypasses RLS entirely — the tables stay protected
  // while the view hands every household's rows to anyone signed in.
  for (const view of ['spending_transactions', 'active_bills', 'provider_sync_status']) {
    assert.match(
      viewSecurity,
      new RegExp(`alter view ${view} set \\(security_invoker = true\\)`, 'i'),
      `${view} would bypass RLS`,
    );
  }
});

test('the household helper is revoked from PUBLIC, not just anon', () => {
  // anon inherits EXECUTE from PUBLIC, so revoking from anon alone is a no-op.
  assert.match(viewSecurity, /revoke execute on function current_household_ids\(\) from public/i);
  assert.match(viewSecurity, /grant execute on function current_household_ids\(\) to authenticated/i);
});

test('duplicate imports are prevented by database constraints, not just code', () => {
  // Application-level dedupe is defeated by concurrent syncs. The unique index
  // is what actually holds.
  assert.match(billsSchema, /create unique index bills_identity_key[\s\S]*?household_id, provider_key, due_date, amount_due/i);
  assert.match(billsSchema, /create unique index bills_source_message_key/i);
  assert.match(billsSchema, /create unique index paystubs_identity_key/i);
  assert.match(billsSchema, /create unique index time_entries_profile_date_key/i);
});

test('account labels are length-capped so a full account number cannot be stored', () => {
  const matches = billsSchema.match(/account_label\s+text check \(account_label is null or length\(account_label\) <= 8\)/gi);
  assert.ok(matches && matches.length >= 2, 'both bills and bill_sources must cap account_label');
});

test('no credentials are stored in the bills or payroll schema', () => {
  // Tokens belong in Vault, referenced by name.
  assert.doesNotMatch(billsSchema, /password/i);
  assert.doesNotMatch(billsSchema, /\baccess_token\s+text/i);
  assert.match(billsSchema, /token_ref/, 'connections reference Vault rather than storing secrets');
});

test('mock providers cannot claim to be live', async () => {
  const { createMockEmailProvider } = await import('../src/providers/mock/mock-email-provider.js');
  const { createMockPayrollProvider } = await import('../src/providers/mock/mock-payroll-provider.js');

  assert.equal(createMockEmailProvider().info.isLive, false);
  assert.equal(createMockPayrollProvider().info.isLive, false);
});

test('no provider adapter hardcodes a credential', () => {
  const providerFiles = allFiles.filter((f) => f.includes('/src/providers/'));
  assert.ok(providerFiles.length > 0);
  for (const file of providerFiles) {
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /(api[_-]?key|client[_-]?secret|password)\s*[:=]\s*['"][^'"]{8,}/i,
      `possible hardcoded credential in ${file.replace(ROOT, '')}`);
  }
});
