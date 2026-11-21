// backend/database/ddl-booking.js
//
// Single source of truth for the booking-lead tracking DDL, shared by
// migrate-booking.js and scripts/setup-test-db.js so a fresh test database is
// byte-identical to a migrated one.
//
// booking_leads stores one row per booking inquiry. Channels:
//   whatsapp / email -> a stay inquiry with check_in/check_out
//   question         -> the mini "Ask a question" form; dates are optional
//                       (both columns NULL) and guests defaults to 1.
// `client_ref` is the idempotency key supplied by the client: UNIQUE means a
// duplicate submission returns the existing lead instead of writing a second
// row (and sending a second email). MySQL allows multiple NULLs in a UNIQUE
// column, so leads without a client_ref are unaffected.
//
// Email columns form the delivery state machine used by services/booking.js:
//   not_required -> WhatsApp lead, no mail
//   pending      -> inserted, delivery not attempted yet
//   sending      -> claimed by one worker (email_attempts incremented)
//   sent         -> delivered; email_sent_at set
//   failed       -> delivery failed; email_error_code is a whitelisted code and
//                   email_error is the fixed label "Email delivery failed".
// Raw SMTP messages, hostnames and recipient addresses are never stored.
//
// booking_events is anonymous conversion tracking only. It has NO IP, user
// agent, email, phone or any other PII: event name, page, room, an optional
// opaque session id and an optional lead id.

const bookingLeadsDDL = `
  CREATE TABLE IF NOT EXISTS booking_leads (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NULL,
    phone VARCHAR(32) NULL,
    check_in DATE NULL,
    check_out DATE NULL,
    guests TINYINT UNSIGNED NOT NULL DEFAULT 1,
    room_slug VARCHAR(100) NULL,
    message TEXT NOT NULL,
    first_message TEXT NOT NULL,
    channel ENUM('whatsapp','email','question') NOT NULL,
    status ENUM('new','contacted','confirmed','cancelled') NOT NULL DEFAULT 'new',
    source_page VARCHAR(255) NULL,
    client_ref VARCHAR(64) NULL,
    email_status ENUM('not_required','pending','sending','sent','failed') NOT NULL DEFAULT 'not_required',
    email_sent_at DATETIME NULL,
    email_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    email_last_attempt_at DATETIME NULL,
    email_error_code VARCHAR(50) NULL,
    email_error VARCHAR(255) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_booking_leads_client_ref (client_ref),
    INDEX idx_booking_leads_status_created (status, created_at),
    INDEX idx_booking_leads_channel_created (channel, created_at),
    INDEX idx_booking_leads_email_status_attempt (email_status, email_last_attempt_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const bookingEventsDDL = `
  CREATE TABLE IF NOT EXISTS booking_events (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    event ENUM('wa_click','email_click','form_open','form_submit') NOT NULL,
    source_page VARCHAR(255) NULL,
    room_slug VARCHAR(100) NULL,
    session_id VARCHAR(64) NULL,
    lead_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_booking_events_event_created (event, created_at),
    INDEX idx_booking_events_source_page (source_page)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// Applied to existing installs and to a scratch database created before the
// question channel existed. Each statement is safe to run repeatedly: MODIFY to
// the same definition is a no-op in MySQL/MariaDB.
const bookingQuestionMigrationDDL = Object.freeze([
  "ALTER TABLE booking_leads MODIFY channel ENUM('whatsapp','email','question') NOT NULL",
  'ALTER TABLE booking_leads MODIFY check_in DATE NULL, MODIFY check_out DATE NULL',
  'ALTER TABLE booking_leads MODIFY guests TINYINT UNSIGNED NOT NULL DEFAULT 1',
]);

module.exports = { bookingLeadsDDL, bookingEventsDDL, bookingQuestionMigrationDDL };
