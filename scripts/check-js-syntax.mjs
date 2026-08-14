import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname;
const DIRECTORIES = ['src', 'web', 'scripts', 'tests', 'fixtures'];
const failures = [];
let checked = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.(?:js|mjs)$/.test(name)) continue;
    checked += 1;
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (error) {
      failures.push({
        file: relative(ROOT, path),
        output: String(error.stderr || error.stdout || error.message).trim(),
      });
    }
  }
}

for (const directory of DIRECTORIES) walk(join(ROOT, directory));

if (failures.length) {
  for (const failure of failures) {
    console.error(`\nSyntax error: ${failure.file}\n${failure.output}`);
  }
  process.exit(1);
}

console.log(`syntax ok: ${checked} JavaScript modules`);
