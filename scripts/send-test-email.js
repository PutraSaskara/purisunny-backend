// backend/scripts/send-test-email.js
//
// Activation-day check for the contact form's mail delivery.
//
// Sends ONE clearly-marked test email to EMAIL_TO using exactly the same
// config and rendering path as POST /api/contact, then prints whether it
// worked. Nothing is written to the database.
//
// Usage (from backend/, after filling EMAIL_* in backend/.env):
//   npm run mail:test
//
// What it prints:
//   - missing EMAIL_* KEY NAMES when the config is incomplete (never values)
//   - the SMTP error message when the server refuses the message
//   - the recipient address on success (so the owner knows where to look)
//
// Secrets are never printed. Exit code 0 = delivered, 1 = not delivered.

const path = require('path');
// This is an owner-run CLI: load backend/.env (not the test profile).
if (!process.env.DOTENV_PROFILE) process.env.DOTENV_PROFILE = 'default';
require(path.join(__dirname, '..', 'config', 'loadEnv'))();

const mailer = require('../utils/mailer');

async function main() {
  const missing = mailer.missingEmailConfigKeys();
  if (missing.length > 0) {
    console.error('Contact email is NOT configured.');
    console.error(`Missing in backend/.env: ${missing.join(', ')}`);
    console.error('Fill those in (see EMAIL-SETUP.md in the repository root), then run this again.');
    process.exitCode = 1;
    return;
  }

  const config = mailer.emailConfig();
  console.log(`Sending test email ${config.from} -> ${config.to} via ${config.host}:${config.port} (secure=${config.secure}) ...`);

  const result = await mailer.sendContactEmail({
    name: 'TES EMAIL — Puri Sunny (abaikan)',
    email: config.from, // replyTo points back at the sender for the test
    phone: '',
    message:
      'Ini email uji coba dari sistem form kontak website Puri Sunny. ' +
      'Jika Anda menerima email ini, pengiriman email sudah berfungsi. ' +
      'Email ini boleh diabaikan.',
  });

  if (result.sent) {
    console.log(`SUCCESS: test email accepted by the SMTP server. Check the inbox of ${config.to} (and the Spam folder).`);
    process.exitCode = 0;
    return;
  }

  console.error(`FAILED: ${result.error || 'unknown error'}`);
  console.error('Check EMAIL_HOST / EMAIL_PORT / EMAIL_SECURE / EMAIL_USER / EMAIL_PASS in backend/.env.');
  console.error('See EMAIL-SETUP.md in the repository root.');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`FAILED: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
