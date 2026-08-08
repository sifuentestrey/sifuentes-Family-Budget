import type { BillExtraction } from './types';

const MONEY = /(?:\$|USD\s*)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d{2})|[0-9]+(?:\.\d{2}))/i;

const AMOUNT_LABELS = [
  /(?:total amount due|amount due|total due|balance due|current amount due)\s*[:\-]?\s*(?:USD\s*)?\$?\s*([0-9,]+(?:\.\d{2})?)/i,
  /(?:payment due|pay this amount)\s*[:\-]?\s*(?:USD\s*)?\$?\s*([0-9,]+(?:\.\d{2})?)/i,
];

const DATE_LABEL = /(?:due date|payment due date|due)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i;

function money(value: string): number {
  return Number(value.replace(/,/g, ''));
}

function findAmount(text: string): number | undefined {
  for (const pattern of AMOUNT_LABELS) {
    const match = text.match(pattern);
    if (match?.[1]) return money(match[1]);
  }

  const generic = text.match(MONEY);
  return generic?.[1] ? money(generic[1]) : undefined;
}

function normalizeDate(value: string): string | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10);
}

/**
 * First-pass deterministic bill extraction.
 * Provider-specific parsers can override this when a utility uses unusual wording.
 */
export function extractBill(text: string, providerName?: string): BillExtraction {
  const amountDue = findAmount(text);
  const dueMatch = text.match(DATE_LABEL);
  const dueDate = dueMatch?.[1] ? normalizeDate(dueMatch[1]) : undefined;

  const matchedFields: string[] = [];
  if (amountDue !== undefined) matchedFields.push('amountDue');
  if (dueDate) matchedFields.push('dueDate');
  if (providerName) matchedFields.push('providerName');

  const confidence =
    amountDue !== undefined && dueDate ? 0.95 :
    amountDue !== undefined ? 0.80 :
    0.20;

  return {
    providerName,
    amountDue,
    dueDate,
    confidence,
    matchedFields,
  };
}
