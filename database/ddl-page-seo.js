// backend/database/ddl-page-seo.js
//
// Single source of truth for the page_seo / faq_items DDL, shared by
// migrate-page-seo.js and scripts/setup-test-db.js so a fresh test database is
// byte-identical to a migrated one.
//
// faq_items.page_key carries an index for its two real access patterns:
//   - lookup by page_key            -> idx_faq_items_page_key (prefix of the composite)
//   - ordered read per page         -> idx_faq_items_page_position (page_key, position)
// The composite index supersedes the single-column one, so it is the only index
// created here (P3-2). An existing install's single-column index is absorbed by
// migrate-page-seo-fk-index.js.

const pageSeoDDL = `
  CREATE TABLE IF NOT EXISTS page_seo (
    id INT AUTO_INCREMENT PRIMARY KEY,
    page_key VARCHAR(100) NOT NULL UNIQUE,
    meta_title VARCHAR(255) NULL,
    meta_description VARCHAR(500) NULL,
    og_image VARCHAR(500) NULL,
    noindex TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const faqItemsDDL = `
  CREATE TABLE IF NOT EXISTS faq_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    page_key VARCHAR(100) NOT NULL,
    question VARCHAR(255) NOT NULL,
    answer TEXT NOT NULL,
    position INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_faq_items_page_position (page_key, position)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

module.exports = { pageSeoDDL, faqItemsDDL };
