'use strict';

const store = require('../lib/store');
const auth = require('../lib/auth');

async function main() {
  if (String(process.env.DEMO_MODE || '').toLowerCase() !== 'true') return;

  const username = String(process.env.DEMO_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.DEMO_ADMIN_PASSWORD || '');
  if (!username || !password) {
    console.log('Demo admin bootstrap skipped: DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD not set.');
    return;
  }
  if (password.length < 8) throw new Error('DEMO_ADMIN_PASSWORD must be at least 8 characters.');

  await store.init();
  const existing = await store.getUserByUsername(username);
  if (!existing) {
    await store.createUser({
      username,
      password_hash: await auth.hashPassword(password),
      role: 'admin',
      person_id: 'PER-001',
      display_name: 'Demo Administrator',
      active: 'Yes',
    });
    console.log('Created demo administrator account.');
  } else {
    console.log('Demo administrator already exists; leaving its password unchanged.');
  }
  await store.close();
}

main().catch((err) => {
  console.error('Demo bootstrap failed:', err.message);
  process.exit(1);
});
