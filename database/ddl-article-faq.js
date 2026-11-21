// backend/database/ddl-article-faq.js
//
// Single source of truth for the article_faq_items DDL, shared by
// migrate-article-faq.js, scripts/verify-integrity.js and the tests.
// database/schema.sql carries the same statements for fresh installs.
//
// Article FAQs are a SEPARATE table from the page-level faq_items
// (routes/seo.js): that flow is keyed on page_seo.page_key and its contract
// must not change.
//
// Conventions mirror faq_items: utf8mb4_unicode_ci, TIMESTAMP created_at /
// updated_at ON UPDATE, question VARCHAR(255), answer TEXT, position INT.
// MariaDB 10.4 (MySQL-5.7 compat): no BOOLEAN/TINYINT here — nothing in this
// table is a flag, and `position` is a real INT.
//
// Indexes:
//   - idx_article_faq_article_position (article_id, position) — the FK column
//     and the ordered read (WHERE article_id = ? ORDER BY position, id).
//   - fk_article_faq_article — article_id -> articles(id) ON DELETE CASCADE,
//     so deleting an article can never leave orphaned FAQs behind.

const ARTICLE_FAQ_TABLE = 'article_faq_items';
const ARTICLE_FAQ_FK_NAME = 'fk_article_faq_article';
const ARTICLE_FAQ_INDEX_NAME = 'idx_article_faq_article_position';
const ARTICLE_FAQ_PARENT_TABLE = 'articles';

// The FK + index are declared inline: an install that already ran
// migrate-article-faq.js has them, so CREATE TABLE IF NOT EXISTS is a no-op
// and the two shapes cannot drift.
const articleFaqItemsDDL = `
  CREATE TABLE IF NOT EXISTS article_faq_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    question VARCHAR(255) NOT NULL,
    answer TEXT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX ${ARTICLE_FAQ_INDEX_NAME} (article_id, position),
    CONSTRAINT ${ARTICLE_FAQ_FK_NAME}
      FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

module.exports = {
  ARTICLE_FAQ_TABLE,
  ARTICLE_FAQ_FK_NAME,
  ARTICLE_FAQ_INDEX_NAME,
  ARTICLE_FAQ_PARENT_TABLE,
  articleFaqItemsDDL,
};
