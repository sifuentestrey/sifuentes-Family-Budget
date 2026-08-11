// GENERATED FILE — do not edit.
// Source of truth: src/ingestion/pdf-parser.js
// Regenerate with: npm run sync:shared
/**
 * PDF bill parsing (DocumentParser).
 *
 * Text extraction is injected rather than imported here, so this file has no
 * runtime-bound dependency baked into it — Node tests and the Deno edge
 * function each supply their own thin wrapper around a PDF-to-text library
 * (`unpdf`, imported as a bare specifier in one runtime and `npm:unpdf` in
 * the other), and this file never needs to know which. Same pattern as the
 * Gmail adapter's injected `fetchImpl`.
 *
 * Everything about recognizing a bill still lives in `bill-parser.js` — this
 * file's only job is turning PDF bytes into the text that already knows how
 * to parse.
 */

import { parseBillText } from './bill-parser.js';

/**
 * @param {object} options
 * @param {(bytes: Uint8Array) => Promise<string>} options.extractText
 * @returns {import('../providers/types.js').DocumentParser}
 */
export function createPdfParser({ extractText }) {
  return {
    key: 'pdf',

    canParse(input) {
      return input?.kind === 'pdf' && input.bytes?.length > 0;
    },

    async parse(input) {
      let text;
      try {
        text = await extractText(input.bytes);
      } catch (error) {
        return { fields: {}, confidence: 0, warnings: [`could not read PDF: ${error.message}`] };
      }

      const fields = parseBillText(text, {
        subject: input.subject,
        fromAddress: input.fromAddress,
        providerName: input.providerName,
      });
      return { fields, confidence: fields.confidence, warnings: fields.warnings };
    },
  };
}
