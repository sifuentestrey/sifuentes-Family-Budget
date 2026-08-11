/**
 * PDF bill parsing.
 *
 * Text extraction is real here (via `unpdf`, the same dependency the Deno
 * edge function reaches via `npm:unpdf`) rather than stubbed, because the
 * thing actually worth testing is that a real PDF's bytes survive the trip
 * through Gmail's base64url encoding and back out as text `parseBillText`
 * can read — a stub would test nothing but the plumbing around it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, getDocumentProxy } from 'unpdf';

import { createPdfParser } from '../src/ingestion/pdf-parser.js';

/**
 * A minimal single-page PDF, one line of text per line of input. Built by
 * hand (no PDF-writing dependency) rather than checked in as a binary
 * fixture, so the exact text content is visible right next to the assertions
 * that check it.
 *
 * Page size is standard US Letter (612x792pt) — pdf.js drops text positioned
 * beyond the page's MediaBox from extraction entirely (confirmed against a
 * narrower test box, where a long line was silently cut off mid-string), so
 * an unrealistically small page would be a self-inflicted test bug, not
 * something a real statement PDF (always a real page size) would ever hit.
 * Multiple lines move down via Td between them, same as any real layout.
 */
function minimalPdf(text) {
  const escape = (s) => s.replace(/([()\\])/g, '\\$1');
  const lines = text.split('\n');
  const showLines = lines
    .map((line, i) => `${i === 0 ? '10 750 Td' : '0 -16 Td'}\n(${escape(line)}) Tj`)
    .join('\n');
  const stream = `BT\n/F1 12 Tf\n${showLines}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

async function unpdfExtractText(bytes) {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

test('a real PDF with bill language parses the amount and due date', async () => {
  const bytes = minimalPdf('Total Amount Due $203.17 Due Date: 08/08/2026');
  const parser = createPdfParser({ extractText: unpdfExtractText });

  assert.ok(parser.canParse({ kind: 'pdf', bytes }));
  const result = await parser.parse({ kind: 'pdf', bytes, subject: 'Your statement', providerName: 'Example Power' });

  assert.equal(result.fields.amountDue, 203.17);
  assert.equal(result.fields.dueDate, '2026-08-08');
  assert.ok(result.confidence > 0.7);
});

test('canParse rejects non-PDF input and empty byte arrays', () => {
  const parser = createPdfParser({ extractText: unpdfExtractText });
  assert.equal(parser.canParse({ kind: 'html', bytes: new Uint8Array([1]) }), false);
  assert.equal(parser.canParse({ kind: 'pdf', bytes: new Uint8Array(0) }), false);
  assert.equal(parser.canParse({ kind: 'pdf' }), false);
});

test('a PDF with no billing language parses with low confidence rather than throwing', async () => {
  const bytes = minimalPdf('Thanks for being a customer!');
  const parser = createPdfParser({ extractText: unpdfExtractText });
  const result = await parser.parse({ kind: 'pdf', bytes });
  assert.equal(result.fields.amountDue, undefined);
  assert.ok(result.confidence < 0.7);
});

test('a broken extractor produces a zero-confidence result with a warning, not a thrown error', async () => {
  const parser = createPdfParser({ extractText: async () => { throw new Error('corrupt PDF'); } });
  const result = await parser.parse({ kind: 'pdf', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(result.confidence, 0);
  assert.match(result.warnings[0], /corrupt PDF/);
});

test('extracted PDF text goes through the same amount-label priority as email body text', async () => {
  // Previous Balance / Payment Received sitting on the line above Total
  // Amount Due is the exact case bill-parser.js exists to get right — a
  // fixed character window would reach up into the wrong line and discard
  // the real total. Three separate lines, as a real statement lays them out,
  // not one run-on string — bill-parser.js's negative-label lookback is
  // scoped to "back to the start of the current line", and proving that
  // requires there to actually be lines.
  const bytes = minimalPdf('Previous Balance $186.44\nPayment Received -$186.44\nTotal Amount Due $203.17');
  const parser = createPdfParser({ extractText: unpdfExtractText });
  const result = await parser.parse({ kind: 'pdf', bytes });
  assert.equal(result.fields.amountDue, 203.17, 'must not pick up the previous balance or the payment');
});
