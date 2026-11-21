// backend/scripts/agent-key.js
//
// CLI for Agent API keys. The full key is printed exactly once on create.
//
// From backend/:
//   npm run agent:key:create -- --name "n8n" --scopes articles:read,articles:write --expires 90d --user admin
//   npm run agent:key:list
//   npm run agent:key:revoke -- --id 3
//
// Expiry accepts 30d, 90d, 365d, 24h, or never. Default 90d.
// Owner defaults to the `admin` user.

require('../config/loadEnv')();

const db = require('../config/db');
const apiKeys = require('../services/apiKeys');
const { AgentError } = require('../agent/errors');
const { KNOWN_SCOPES } = require('../agent/scopes');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const withoutPrefix = token.slice(2);
    const equals = withoutPrefix.indexOf('=');
    if (equals !== -1) {
      args[withoutPrefix.slice(0, equals)] = withoutPrefix.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[withoutPrefix] = true;
    } else {
      args[withoutPrefix] = next;
      index += 1;
    }
  }
  return args;
}

function requireString(args, name, label) {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing --${name}${label ? ` (${label})` : ''}`);
  }
  return value.trim();
}

function formatDate(value) {
  return value || 'never';
}

async function fetchOwner(username) {
  const [rows] = await db.query('SELECT id, username, role FROM users WHERE username = ?', [username]);
  if (!rows || rows.length === 0) {
    throw new Error(
      `User "${username}" not found. Create it first with "npm run seed" (or pass --user <username>).`
    );
  }
  return rows[0];
}

async function commandCreate(args) {
  const name = requireString(args, 'name', 'a short label such as "n8n"');
  const scopes = requireString(args, 'scopes', 'comma-separated, e.g. articles:read,articles:write')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  const username = typeof args.user === 'string' && args.user.trim() !== '' ? args.user.trim() : 'admin';
  const expiresAt = apiKeys.parseExpiry(typeof args.expires === 'string' ? args.expires : '90d');

  const owner = await fetchOwner(username);
  const created = await apiKeys.createApiKey({
    name,
    userId: owner.id,
    role: owner.role,
    scopes,
    expiresAt,
  });

  console.log('\nAPI key created. Store it now: it will never be shown again.\n');
  console.log(`  ${created.key}\n`);
  console.log('  WARNING: this is the only time the full key is displayed.');
  console.log('  Anyone with this key can act within its scopes until it expires or is revoked.\n');
  console.log(`  id:         ${created.apiKey.id}`);
  console.log(`  name:       ${created.apiKey.name}`);
  console.log(`  prefix:     ${created.apiKey.prefix}`);
  console.log(`  owner:      ${owner.username} (${owner.role})`);
  console.log(`  scopes:     ${created.apiKey.scopes.join(', ')}`);
  console.log(`  expires_at: ${formatDate(created.apiKey.expiresAt)}`);
  console.log('');
}

async function commandList() {
  const keys = await apiKeys.listApiKeys();
  if (keys.length === 0) {
    console.log('No API keys found.');
    return;
  }
  console.log('id\tname\tprefix\towner\tscopes\tactive\texpires_at\tlast_used_at');
  for (const key of keys) {
    console.log([
      key.id,
      key.name,
      key.prefix,
      `${key.username} (${key.role})`,
      key.scopes.join(',') || '-',
      key.isActive ? 'yes' : 'no',
      formatDate(key.expiresAt),
      formatDate(key.lastUsedAt),
    ].join('\t'));
  }
}

async function commandRevoke(args) {
  const rawId = requireString(args, 'id', 'numeric key id from agent:key:list');
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('--id must be a positive integer');
  }
  const revoked = await apiKeys.revokeApiKey(id);
  if (!revoked) {
    throw new Error(`API key ${id} not found`);
  }
  console.log(`API key ${id} revoked (is_active=0, revoked_at set).`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (command) {
    case 'create':
      return commandCreate(args);
    case 'list':
      return commandList();
    case 'revoke':
      return commandRevoke(args);
    case 'scopes':
      console.log(KNOWN_SCOPES.join('\n'));
      return undefined;
    default:
      throw new Error(
        'Usage: node scripts/agent-key.js <create|list|revoke> [options]\n' +
        '  create --name <name> --scopes <a,b> [--expires 90d] [--user admin]\n' +
        '  list\n' +
        '  revoke --id <id>'
      );
  }
}

if (require.main === module) {
  main()
    .then(() => db.end())
    .then(() => process.exit(0))
    .catch(async (error) => {
      const message = error instanceof AgentError ? error.message : (error && error.message) || String(error);
      console.error(`Error: ${message}`);
      try { await db.end(); } catch { /* already closed */ }
      process.exit(1);
    });
}

module.exports = { parseArgs, main };
