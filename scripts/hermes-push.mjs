#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const DEFAULT_URL = 'https://ytkpthlhtbxtvtadepqt.supabase.co/functions/v1/hermes-ingest';
const DEFAULT_HOUSEHOLD_ID = '953f317d-5d02-4c72-b94a-6bef16b42937';

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const token = process.env.FAMILY_BUDGET_HERMES_TOKEN?.trim();
if (!token) fail('Missing FAMILY_BUDGET_HERMES_TOKEN. Store it only in the local Hermes environment.');

const inputPath = process.argv[2];
const raw = inputPath ? await readFile(inputPath, 'utf8') : await readStdin();
if (!raw.trim()) fail('Expected a JSON payload on stdin or as a file path argument.');

let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  fail(`Payload is not valid JSON: ${error.message}`);
}

if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
  fail('Payload must be a JSON object.');
}

payload.household_id ||= process.env.FAMILY_BUDGET_HOUSEHOLD_ID?.trim() || DEFAULT_HOUSEHOLD_ID;
payload.observed_at ||= new Date().toISOString();

const url = process.env.FAMILY_BUDGET_HERMES_URL?.trim() || DEFAULT_URL;
const response = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

const responseText = await response.text();
let result;
try {
  result = JSON.parse(responseText);
} catch {
  result = { raw: responseText };
}

console.log(JSON.stringify(result, null, 2));
if (!response.ok || result?.ok !== true) process.exit(1);
