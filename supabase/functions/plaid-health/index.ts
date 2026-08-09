/**
 * Configuration health check.
 *
 * Reports whether the Plaid environment variables are present and well-formed,
 * WITHOUT echoing any of them. Setup goes wrong in quiet ways — a value in the
 * wrong variable, a trailing space, a secret pasted where an environment name
 * belongs — and every one of those produces the same unhelpful failure at the
 * point of use.
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
  const clientId = Deno.env.get('PLAID_CLIENT_ID');
  const secret = Deno.env.get('PLAID_SECRET');
  const environment = Deno.env.get('PLAID_ENV');

  const problems: string[] = [];

  // --- PLAID_CLIENT_ID
  if (!clientId) {
    problems.push('PLAID_CLIENT_ID is not set.');
  } else if (clientId !== clientId.trim()) {
    problems.push('PLAID_CLIENT_ID has leading or trailing whitespace — lookups will fail.');
  } else if (!/^[a-f0-9]{20,30}$/i.test(clientId)) {
    problems.push(
      'PLAID_CLIENT_ID does not look like a Plaid client id ' +
      '(expected ~24 hexadecimal characters). Check the value is not a secret or a name.',
    );
  }

  // --- PLAID_SECRET
  if (!secret) {
    problems.push('PLAID_SECRET is not set.');
  } else if (secret !== secret.trim()) {
    problems.push('PLAID_SECRET has leading or trailing whitespace.');
  } else if (!/^[a-f0-9]{20,40}$/i.test(secret)) {
    problems.push(
      'PLAID_SECRET does not look like a Plaid secret (expected ~30 hexadecimal characters).',
    );
  }

  // --- PLAID_ENV. The one most often filled in with a credential.
  if (!environment) {
    problems.push("PLAID_ENV is not set. It should be the word 'sandbox' or 'production'.");
  } else if (!VALID_ENVIRONMENTS.includes(environment.trim().toLowerCase())) {
    problems.push(
      `PLAID_ENV must be exactly 'sandbox' or 'production'. It currently holds something else ` +
      `(${environment.length} characters). If a credential was pasted here, it belongs in ` +
      `PLAID_SECRET instead — PLAID_ENV only names which Plaid server to call.`,
    );
  } else if (environment !== environment.trim().toLowerCase()) {
    problems.push("PLAID_ENV has stray whitespace or capitals; use exactly 'sandbox'.");
  }

  // Same value in two variables is a copy-paste slip worth catching.
  if (clientId && secret && clientId === secret) {
    problems.push('PLAID_CLIENT_ID and PLAID_SECRET hold the same value.');
  }

  const ready = problems.length === 0;

  return new Response(JSON.stringify({
    ready,
    checks: {
      PLAID_CLIENT_ID: describe(clientId),
      PLAID_SECRET: describe(secret),
      PLAID_ENV: environment
        ? (VALID_ENVIRONMENTS.includes(environment.trim().toLowerCase())
            ? `set to '${environment.trim().toLowerCase()}'`
            : 'set, but not a valid environment name')
        : 'missing',
    },
    problems,
    plaidHost: ready ? `https://${environment!.trim().toLowerCase()}.plaid.com` : null,
  }, null, 2), {
    status: ready ? 200 : 409,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});

/** Presence and rough shape only — never the value, never an exact length. */
function describe(value: string | undefined) {
  if (!value) return 'missing';
  const bucket = value.length < 20 ? 'short' : value.length <= 40 ? 'plausible length' : 'long';
  const shape = /^[a-f0-9]+$/i.test(value) ? 'hex' : 'contains non-hex characters';
  return `set (${bucket}, ${shape})`;
}
