/**
 * Configuration health check.
 *
 * Reports whether the Plaid environment variables are present and well-formed,
 * WITHOUT echoing any of them. Setup goes wrong in quiet ways — a value in the
 * wrong variable, a trailing space, a secret pasted where an environment name
 * belongs — and every one of those produces the same unhelpful failure at the
 * point of use.
 *
 * Whitespace around a pasted value is treated as cosmetic, not fatal: every
 * function that reads these variables (`plaid-link-token`, `plaid-exchange`,
 * `sync-transactions`, and this one) calls `.trim()` at the point of use, so
 * this check reports whitespace as a note rather than blocking on it.
 * Copy-paste from a chat message or a notes app routinely carries an invisible
 * trailing newline, and refusing to work until a human retypes a credential by
 * hand is a worse fix than just not caring about the whitespace.
 *
 * Deliberately unauthenticated so it can be checked before any user account
 * exists. The only thing it discloses is that this project intends to talk to
 * Plaid, which is not sensitive. Lengths are reported as ranges rather than
 * exact values, so nothing here narrows down a secret.
 */

const VALID_ENVIRONMENTS = ['sandbox', 'production'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(() => {
  const rawClientId = Deno.env.get('PLAID_CLIENT_ID');
  const rawSecret = Deno.env.get('PLAID_SECRET');
  const rawEnvironment = Deno.env.get('PLAID_ENV');

  const clientId = rawClientId?.trim();
  const secret = rawSecret?.trim();
  const environment = rawEnvironment?.trim().toLowerCase();

  const problems: string[] = [];
  const notes: string[] = [];

  // --- PLAID_CLIENT_ID
  if (!clientId) {
    problems.push('PLAID_CLIENT_ID is not set.');
  } else {
    if (rawClientId !== clientId) notes.push('PLAID_CLIENT_ID has surrounding whitespace — ignored automatically.');
    if (!/^[a-f0-9]{20,30}$/i.test(clientId)) {
      problems.push(
        'PLAID_CLIENT_ID does not look like a Plaid client id ' +
        '(expected ~24 hexadecimal characters). Check the value is not a secret or a name.',
      );
    }
  }

  // --- PLAID_SECRET
  if (!secret) {
    problems.push('PLAID_SECRET is not set.');
  } else {
    if (rawSecret !== secret) notes.push('PLAID_SECRET has surrounding whitespace — ignored automatically.');
    if (!/^[a-f0-9]{20,40}$/i.test(secret)) {
      problems.push('PLAID_SECRET does not look like a Plaid secret (expected ~30 hexadecimal characters).');
    }
  }

  // --- PLAID_ENV. The one most often filled in with a credential instead.
  if (!environment) {
    problems.push("PLAID_ENV is not set. It should be the word 'sandbox' or 'production'.");
  } else if (!VALID_ENVIRONMENTS.includes(environment)) {
    problems.push(
      `PLAID_ENV must be exactly 'sandbox' or 'production'. It currently holds something else ` +
      `(${environment.length} characters after trimming). If a credential was pasted here, it ` +
      `belongs in PLAID_SECRET instead — PLAID_ENV only names which Plaid server to call.`,
    );
  } else if (rawEnvironment?.trim() !== rawEnvironment) {
    notes.push("PLAID_ENV has surrounding whitespace — ignored automatically.");
  }

  // Same value in two variables is a copy-paste slip worth catching regardless
  // of whitespace.
  if (clientId && secret && clientId === secret) {
    problems.push('PLAID_CLIENT_ID and PLAID_SECRET hold the same value.');
  }

  const ready = problems.length === 0;

  return new Response(JSON.stringify({
    ready,
    checks: {
      PLAID_CLIENT_ID: describe(rawClientId, clientId),
      PLAID_SECRET: describe(rawSecret, secret),
      PLAID_ENV: environment
        ? (VALID_ENVIRONMENTS.includes(environment) ? `set to '${environment}'` : 'set, but not a valid environment name')
        : 'missing',
    },
    problems,
    notes,
    plaidHost: ready ? `https://${environment}.plaid.com` : null,
  }, null, 2), {
    status: ready ? 200 : 409,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});

/** Presence and rough shape only — never the value, never an exact length. */
function describe(raw: string | undefined, trimmed: string | undefined) {
  if (!trimmed) return 'missing';
  const bucket = trimmed.length < 20 ? 'short' : trimmed.length <= 40 ? 'plausible length' : 'long';
  const shape = /^[a-f0-9]+$/i.test(trimmed) ? 'hex' : 'contains non-hex characters';
  const whitespace = raw !== trimmed ? ', had whitespace (auto-trimmed)' : '';
  return `set (${bucket}, ${shape}${whitespace})`;
}
