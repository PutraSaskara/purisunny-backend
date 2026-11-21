// Loads the right dotenv profile before anything reads process.env.
//   - backend/.env.test (scratch DB profile) when it exists, for tests/CLI
//   - backend/.env otherwise
// server.js keeps its own dotenv load because it may be started from anywhere.
require('./config/loadEnv')();

const createApp = require('./app');

// ---------------------------------------------------------------------------
// Fail-fast config guard. A missing/weak JWT_SECRET would silently let the app
// boot and then either throw per-request or accept tokens signed with a guessable
// key, so refuse to start instead.
// ---------------------------------------------------------------------------
const JWT_SECRET_MIN_LENGTH = 32;
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < JWT_SECRET_MIN_LENGTH) {
  console.error(
    `FATAL: JWT_SECRET is ${jwtSecret ? 'too short' : 'missing'} ` +
    `(minimum ${JWT_SECRET_MIN_LENGTH} characters). ` +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))" ' +
    'and set it in backend/.env'
  );
  process.exit(1);
}

const app = createApp();
const PORT = process.env.PORT || 5000;

// One-line contact-email status. Names the missing .env keys only — never
// values. Missing config is NOT fatal: the contact form still stores rows and
// routes visitors to WhatsApp until the domain email exists.
require('./utils/mailer').verifyEmailConfig();

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
