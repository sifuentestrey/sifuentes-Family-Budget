/**
 * Copy the engine into supabase/functions/_shared/ for deployment.
 *
 * The engine has exactly one source of truth: src/engine/. Supabase deploys a
 * function directory and does not reliably bundle imports from outside it, so
 * the files are copied rather than imported across that boundary.
 *
 * Two copies of categorization logic silently diverging would be a genuinely
 * nasty bug — the app would show one set of numbers and the nightly sync would
 * write another. So this runs automatically before deploy, and CI verifies the
 * copies match (`npm run check:shared`).
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = new URL('../src/engine/', import.meta.url).pathname;
const DEST = new URL('../supabase/functions/_shared/', import.meta.url).pathname;

const BANNER = `// GENERATED FILE — do not edit.
// Source of truth: src/engine/%NAME%
// Regenerate with: npm run sync:shared
`;

const check = process.argv.includes('--check');
mkdirSync(DEST, { recursive: true });

let drift = false;
for (const name of readdirSync(SOURCE).filter((f) => f.endsWith('.js'))) {
  const content = BANNER.replace('%NAME%', name) + readFileSync(join(SOURCE, name), 'utf8');
  const target = join(DEST, name);

  if (check) {
    let existing = '';
    try {
      existing = readFileSync(target, 'utf8');
    } catch {
      /* missing counts as drift */
    }
    if (existing !== content) {
      console.error(`drift: ${name} differs from src/engine/${name}`);
      drift = true;
    }
  } else {
    writeFileSync(target, content);
    console.log(`copied ${name}`);
  }
}

if (check && drift) {
  console.error('\nRun `npm run sync:shared` to resync.');
  process.exit(1);
}
if (check) console.log('_shared is in sync with src/engine');
