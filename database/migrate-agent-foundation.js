// backend/database/migrate-agent-foundation.js
//
// Idempotent Phase 1 Agent API foundation migration:
//   api_keys, agent_audit_log, idempotency_keys
//
// Safe to run multiple times (CREATE TABLE IF NOT EXISTS). It never alters
// existing tables or data. Keep in sync with database/schema.sql.
//
// Usage (from backend/):
//   node database/migrate-agent-foundation.js
//   npm run migrate:agent-foundation

require('../config/loadEnv')();
const db = require('../config/db');

const DDL = [
  `CREATE TABLE IF NOT EXISTS api_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    key_prefix VARCHAR(16) NOT NULL UNIQUE,
    key_hash CHAR(64) NOT NULL UNIQUE,
    user_id INT NOT NULL,
    scopes TEXT NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    expires_at DATETIME NULL,
    last_used_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME NULL,
    INDEX idx_api_keys_user_id (user_id),
    INDEX idx_api_keys_is_active (is_active),
    CONSTRAINT fk_api_keys_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS agent_audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    api_key_id INT NULL,
    user_id INT NULL,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(500) NOT NULL,
    resource_type VARCHAR(50) NULL,
    resource_id VARCHAR(100) NULL,
    status_code SMALLINT NOT NULL,
    request_id VARCHAR(64) NOT NULL,
    ip VARCHAR(45) NULL,
    user_agent VARCHAR(255) NULL,
    duration_ms INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_agent_audit_key_created (api_key_id, created_at),
    INDEX idx_agent_audit_created (created_at),
    CONSTRAINT fk_agent_audit_api_key
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
    CONSTRAINT fk_agent_audit_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    api_key_id INT NOT NULL,
    idem_key VARCHAR(255) NOT NULL,
    method VARCHAR(10) NOT NULL,
    path VARCHAR(500) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    status_code SMALLINT NULL,
    response_body MEDIUMTEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    UNIQUE KEY uq_idempotency_key (api_key_id, idem_key),
    INDEX idx_idempotency_expires (expires_at),
    CONSTRAINT fk_idempotency_api_key
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function migrate() {
  const database = process.env.DB_NAME || 'purisunny';
  console.log(`Running Agent API foundation migration on "${database}"...`);

  const [tables] = await db.query(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  );
  if (!tables || tables.length === 0) {
    throw new Error(
      `Table 'users' not found in database '${database}'. Run database/schema.sql first.`
    );
  }

  for (const statement of DDL) {
    await db.query(statement);
  }

  console.log('  + api_keys ready');
  console.log('  + agent_audit_log ready');
  console.log('  + idempotency_keys ready');
  console.log('\nAgent API foundation migration complete.');
}

if (require.main === module) {
  migrate()
    .then(() => db.end())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('Migration error:', err.code || '', err.message);
      try { await db.end(); } catch { /* already closed */ }
      process.exit(1);
    });
}

module.exports = { migrate, DDL };
