require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./config/db');

// Admin password is never hardcoded. Provide ADMIN_PASSWORD in the environment
// (or a one-off: $env:ADMIN_PASSWORD="..."; npm run seed) — otherwise a strong
// random password is generated and printed ONCE so it can be captured and
// changed after the first login.
function resolveAdminPassword() {
  const provided = process.env.ADMIN_PASSWORD;
  if (provided && provided.length > 0) {
    if (provided.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters long.');
    }
    return { password: provided, generated: false };
  }
  return {
    password: crypto.randomBytes(18).toString('base64url'),
    generated: true,
  };
}

async function seed() {
  try {
    const { password, generated } = resolveAdminPassword();
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    if (generated) {
      // Printed once, at seed time only — never logged by the server.
      console.log('==========================================================');
      console.log('Generated admin password (store it now, shown only once):');
      console.log(`  ${password}`);
      console.log('Log in and change this password immediately after seeding.');
      console.log('==========================================================');
    }

    // Insert admin user
    await db.query(
      'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE password=?',
      ['admin', 'admin@purisunnymunduk.id', hash, 'admin', hash]
    );
    console.log('Admin user created/updated successfully');
    
    // Insert categories
    const categories = [
      ['Munduk', 'munduk', 'Guides and stories about Munduk Village'],
      ['Nature & Trails', 'nature', 'Waterfalls, trekking, and natural wonders'],
      ['Culture & Subak', 'culture', 'Balinese culture, traditions, and Subak heritage'],
      ['Travel Planning', 'planning', 'Tips and guides for planning your trip'],
      ['Puri Sunny', 'purisunny', 'Updates and stories about Puri Sunny properties'],
    ];
    
    for (const [name, slug, desc] of categories) {
      await db.query(
        'INSERT INTO categories (name, slug, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name=name',
        [name, slug, desc]
      );
    }
    console.log('Categories seeded successfully');
    
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error.message || error);
    process.exit(1);
  }
}

seed();
