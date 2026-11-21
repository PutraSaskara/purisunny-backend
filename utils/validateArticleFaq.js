// backend/utils/validateArticleFaq.js
//
// Validator for the OPTIONAL per-article FAQ list used by
// POST /api/articles and PUT /api/articles/:id (routes/articles.js).
//
// This is intentionally NOT shared with the page-level FAQ validator in
// routes/seo.js: that flow (faq_items + page_seo) is a separate, already-tested
// contract and is left untouched. Caps are mirrored from it exactly so both
// dashboards behave the same:
//
//   item.question  trimmed, non-empty, <= 255   (VARCHAR(255) column)
//   item.answer    trimmed, non-empty, <= 1000  (same cap as the page FAQ flow)
//   list length    <= 20
//   each item      an object (not null, not an array)
//
// Unknown extra keys inside an item are ignored; only question/answer are read.
// `position` is assigned from the array index (0-based) by this module, so the
// stored order is always the order the dashboard sent.
//
// No DB access. Returns { errors: string[], items: [{ question, answer, position }] }
// with errors in the `faqs[...]`-prefixed style the other article 400s use.

const { requiredString } = require('./validate');

const MAX_ARTICLE_FAQS = 20;
const MAX_FAQ_QUESTION_LENGTH = 255;
const MAX_FAQ_ANSWER_LENGTH = 1000;

// Validate a raw `faqs` value.
//   - undefined / null -> the key was not supplied (caller leaves FAQs untouched
//     on PUT); returns { present: false, errors: [], items: [] }
//   - anything else    -> must be an array of items
function validateArticleFaqs(faqs) {
  if (faqs === undefined || faqs === null) {
    return { present: false, errors: [], items: [] };
  }

  if (!Array.isArray(faqs)) {
    return { present: true, errors: ['faqs must be an array'], items: [] };
  }

  const errors = [];
  if (faqs.length > MAX_ARTICLE_FAQS) {
    errors.push(`faqs must have at most ${MAX_ARTICLE_FAQS} items`);
    return { present: true, errors, items: [] };
  }

  const items = [];
  for (let i = 0; i < faqs.length; i++) {
    const faq = faqs[i];
    if (!faq || typeof faq !== 'object' || Array.isArray(faq)) {
      errors.push(`faqs[${i}] must be an object`);
      continue;
    }

    const question = requiredString(faq.question, `faqs[${i}].question`, MAX_FAQ_QUESTION_LENGTH);
    if (question.error) errors.push(question.error);

    const answer = requiredString(faq.answer, `faqs[${i}].answer`, MAX_FAQ_ANSWER_LENGTH);
    if (answer.error) errors.push(answer.error);

    // Row still gets pushed on error: the caller returns 400 before writing, and
    // keeping it out would shift positions once errors are fixed. Positions are
    // re-derived from the final array anyway.
    items.push({
      question: question.error ? null : question.value,
      answer: answer.error ? null : answer.value,
      position: i,
    });
  }

  return { present: true, errors, items };
}

module.exports = {
  MAX_ARTICLE_FAQS,
  MAX_FAQ_QUESTION_LENGTH,
  MAX_FAQ_ANSWER_LENGTH,
  validateArticleFaqs,
};
