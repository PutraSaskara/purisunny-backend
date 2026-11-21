// backend/config/loadEnv.js
//
// Loads the right dotenv profile for CLI entrypoints (migrations, verify
// scripts, tests).
//
//   backend/.env        default for the server and normal dev runs.
//   backend/.env.test   scratch / CI profile. Loaded ONLY when explicitly opted
//                       in, so `npm start` can never silently talk to the
//                       scratch database just because a developer has .env.test
//                       lying around:
//                         NODE_ENV=test            (node --test, npm test)
//                         DOTENV_PROFILE=test      (ad-hoc CLI runs)
//
// A DB_NAME exported in the shell still wins over the profile, so a one-off
// run can target another scratch database (e.g. `$env:DB_NAME='purisunny_fresh'`).

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const backendDir = path.join(__dirname, '..');
  const testEnvPath = path.join(backendDir, '.env.test');

  const wantsTestProfile =
    process.env.DOTENV_PROFILE === 'test' ||
    process.env.NODE_ENV === 'test';

  const useTestProfile =
    wantsTestProfile &&
    process.env.NODE_ENV !== 'production' &&
    fs.existsSync(testEnvPath);

  const explicitDbName = process.env.DB_NAME;

  require('dotenv').config(useTestProfile ? { path: testEnvPath } : undefined);

  if (explicitDbName !== undefined) {
    process.env.DB_NAME = explicitDbName;
  }
  return { testProfile: useTestProfile };
}

module.exports = loadEnv;
