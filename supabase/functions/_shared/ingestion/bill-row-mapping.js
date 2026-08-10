// GENERATED FILE — do not edit.
// Source of truth: src/ingestion/bill-row-mapping.js
// Regenerate with: npm run sync:shared
/**
 * Bill <-> Postgres row mapping.
 *
 * Extracted into its own module specifically so it is unit-testable — the
 * Edge Function that actually talks to Supabase is Deno + `jsr:` imports and
 * cannot be loaded by the Node test runner, and this is exactly the kind of
 * code where a wrong column name fails silently: the insert succeeds, the
 * field is dropped, and the only symptom is a bill that quietly never shows
 * up, or shows up with the wrong amount.
 *
 * `amount_due`, `confidence`, and `paid_amount` are Postgres `numeric`
 * columns, which PostgREST returns as JSON strings, not numbers — the same
 * trap `src/payroll/mapping.js` documents for pay rates. `rowToBill` converts
 * explicitly rather than relying on arithmetic elsewhere to coerce correctly.
 */

export function billToRow(bill) {
  return {
    id: bill.id,
    household_id: bill.householdId,
    bill_source_id: bill.billSourceId ?? null,
    provider_name: bill.providerName,
    provider_key: bill.providerKey,
    category: bill.category,
    account_label: bill.accountLabel ?? null,
    amount_due: bill.amountDue,
    currency: bill.currency ?? 'USD',
    due_date: bill.dueDate,
    statement_date: bill.statementDate ?? null,
    statement_period_start: bill.statementPeriod?.start ?? null,
    statement_period_end: bill.statementPeriod?.end ?? null,
    status: bill.status,
    source: bill.source,
    source_message_id: bill.sourceMessageId ?? null,
    source_document_id: bill.sourceDocumentId ?? null,
    confidence: bill.confidence,
    needs_review: bill.needsReview ?? false,
    detected_at: bill.detectedAt,
    paid_at: bill.paidAt ?? null,
    paid_amount: bill.paidAmount ?? null,
    paid_transaction_id: bill.paidTransactionId ?? null,
    notes: bill.notes ?? null,
    raw: bill.raw ?? null,
  };
}

export function rowToBill(row) {
  return {
    id: row.id,
    householdId: row.household_id,
    billSourceId: row.bill_source_id ?? undefined,
    providerName: row.provider_name,
    providerKey: row.provider_key,
    category: row.category,
    accountLabel: row.account_label ?? undefined,
    amountDue: Number(row.amount_due),
    currency: row.currency,
    dueDate: row.due_date,
    statementDate: row.statement_date ?? undefined,
    statementPeriod: row.statement_period_start
      ? { start: row.statement_period_start, end: row.statement_period_end }
      : undefined,
    status: row.status,
    source: row.source,
    sourceMessageId: row.source_message_id ?? undefined,
    sourceDocumentId: row.source_document_id ?? undefined,
    confidence: Number(row.confidence),
    needsReview: Boolean(row.needs_review),
    detectedAt: row.detected_at,
    paidAt: row.paid_at ?? undefined,
    paidAmount: row.paid_amount != null ? Number(row.paid_amount) : undefined,
    paidTransactionId: row.paid_transaction_id ?? undefined,
    notes: row.notes ?? undefined,
    raw: row.raw ?? undefined,
  };
}
