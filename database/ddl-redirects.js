// backend/database/ddl-redirects.js
//
// Single source of truth for the `redirects` DDL, shared by
// migrate-redirects.js and scripts/setup-test-db.js so a fresh test database is
// byte-identical to a migrated one.
//
// `from_path` is UNIQUE and that unique index is the only one needed: every
// read is an equality lookup on it (the frontend builds a map from GET
// /api/redirects, the article rename path probes one path), and the admin list
// is ordered by the primary key.
//
// `status` is constrained at the DB layer as well as the API layer
// (utils/validateredirects.js allows 301/302 only) via a CHECK constraint.
// MySQL 8 enforces it; MariaDB 10.4 accepts it (tested here: 307 is rejected),
// MySQL 5.7 / older MariaDB parse and ignore it — the API is the primary gate.
//
// Column type is SMALLINT, NOT TINYINT, on purpose. This project's local
// XAMPP MariaDB runs in MySQL-5.7 compatibility mode, where TINYINT is the
// deprecated BOOLEAN alias and is treated as TINYINT(1): any value outside
// -128..127 is silently truncated (INSERT of 301 stored 127), and
// `DEFAULT 301` is rejected outright with ER_INVALID_DEFAULT. SMALLINT holds
// 301/302 exactly on MariaDB 10.4, MySQL 5.7 and MySQL 8 alike.

const redirectsDDL = `
  CREATE TABLE IF NOT EXISTS redirects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    from_path VARCHAR(255) NOT NULL UNIQUE,
    to_path VARCHAR(255) NOT NULL,
    status SMALLINT NOT NULL DEFAULT 301,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_redirects_status CHECK (status IN (301, 302))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

module.exports = { redirectsDDL };
