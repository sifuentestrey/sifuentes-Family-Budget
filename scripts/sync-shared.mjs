/**
 * Copy server-needed source into supabase/functions/_shared/ for deployment.
 *
 * Each directory below has exactly one source of truth under src/. Supabase
 * deploys a function directory and does not reliably bundle imports from
 * outside it, so the files are copied rather than imported across that
 * boundary — a copy per rule, at the same relative path it lives at under
 * src/, so the relative imports inside each file (`./date-parser.js`,
 * `../domain/bill.js`) resolve unchanged on both sides.
 *
 * Two copies of the same logic silently diverging would be a genuinely nasty
 * bug — the app would show one set of numbers and the nightly sync would
 * write another. So this runs automatically before deploy, and CI verifies
 * every copy matches (`npm run check:shared`).
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEST_ROOT = new URL('../supabase/functions/_shared/', import.meta.url).pathname;

// { source: relative to src/, dest: relative to supabase/functions/_shared/ }
const RULES = [
  // Flat: files in src/engine/ only ever import siblings via `./`, so they
  // land directly in _shared/ itself, matching the layout sync-transactions
  // has always imported against.
  { source: 'engine', dest: '' },
  { source: 'domain', dest: 'domain' },
  // Nested the same way under src/engine/ and _shared/ so a file at either
  // level (e.g. advisor-summary.js importing './budget/safe-to-spend.js')
  // resolves identically on both sides — the flat engine rule above only
  // works for siblings, so anything engine/*.js reaches outside itself has
  // to nest symmetrically like this rather than via a '../' import.
  { source: 'engine/budget', dest: 'budget' },
  { source: 'ingestion', dest: 'ingestion' },
  { source: 'sync', dest: 'sync' },
];

// Single files, named explicitly rather than by directory, so files that
// exist only for the browser or for tests (mock providers, the registry)
// don't end up bundled into an Edge Function that never uses them.
const SINGLE_FILES = [
  { source: 'providers/gmail-email-provider.js', dest: 'providers/gmail-email-provider.js' },
];

const check = process.argv.includes('--check');
let drift = false;

function syncFile(sourcePath, sourceLabel, destPath) {
  const banner = `// GENERATED FILE — do not edit.
// Source of truth: src/${sourceLabel}
// Regenerate with: npm run sync:shared
`;
  const content = banner + readFileSync(sourcePath, 'utf8');
  mkdirSync(join(destPath, '..'), { recursive: true });

  if (check) {
    let existing = '';
    try {
      existing = readFileSync(destPath, 'utf8');
    } catch {
      /* missing counts as drift */
    }
    if (existing !== content) {
      console.error(`drift: ${sourceLabel} differs from its copy in supabase/functions/_shared/`);
      drift = true;
    }
  } else {
    writeFileSync(destPath, content);
    console.log(`copied ${sourceLabel}`);
  }
}

for (const rule of RULES) {
  const sourceDir = new URL(`../src/${rule.source}/`, import.meta.url).pathname;
  const destDir = join(DEST_ROOT, rule.dest);
  mkdirSync(destDir, { recursive: true });

  for (const name of readdirSync(sourceDir).filter((f) => f.endsWith('.js'))) {
    syncFile(join(sourceDir, name), `${rule.source}/${name}`, join(destDir, name));
  }
}

for (const file of SINGLE_FILES) {
  const sourcePath = new URL(`../src/${file.source}`, import.meta.url).pathname;
  syncFile(sourcePath, file.source, join(DEST_ROOT, file.dest));
}

if (check && drift) {
  console.error('\nRun `npm run sync:shared` to resync.');
  process.exit(1);
}
if (check) console.log('_shared is in sync with src/');
