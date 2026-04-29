#!/usr/bin/env node
// Run once after cloning: npm run setup
import webpush from 'web-push';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const notifyScript = path.join(projectDir, 'hq-notify.sh');

// ── VAPID keys ────────────────────────────────────────────────────────────────
const envPath = path.join(projectDir, '.env');
let publicKey, privateKey;

if (fs.existsSync(envPath)) {
  const existing = fs.readFileSync(envPath, 'utf8');
  const pub = existing.match(/VAPID_PUBLIC_KEY=(.+)/)?.[1];
  const priv = existing.match(/VAPID_PRIVATE_KEY=(.+)/)?.[1];
  if (pub && priv && !pub.includes('your_vapid')) {
    console.log('✓ .env already configured — skipping VAPID key generation');
    publicKey = pub.trim();
    privateKey = priv.trim();
  }
}

if (!publicKey) {
  const keys = webpush.generateVAPIDKeys();
  publicKey = keys.publicKey;
  privateKey = keys.privateKey;
  fs.writeFileSync(envPath,
    `VAPID_PUBLIC_KEY=${publicKey}\n` +
    `VAPID_PRIVATE_KEY=${privateKey}\n` +
    `VAPID_EMAIL=mailto:you@example.com\n` +
    `BASE_DIR=${os.homedir()}\n` +
    `PORT=4242\n`
  );
  console.log('✓ Generated VAPID keys and wrote .env');
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'Stop', 'PermissionRequest',
  'SubagentStart', 'SubagentStop',
  'TaskCreated', 'TaskCompleted',
  'Notification', 'CwdChanged',
];

const hookEntry = (event) => ({
  matcher: '',
  hooks: [{ type: 'command', command: `bash "${notifyScript}" ${event}`, async: true }],
});

try {
  const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
  const settings = JSON.parse(raw);
  settings.hooks = settings.hooks || {};
  EVENTS.forEach(e => { settings.hooks[e] = [hookEntry(e)]; });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  console.log('✓ Patched ~/.claude/settings.json with all HQ hooks');
} catch (err) {
  console.warn('⚠ Could not update Claude settings:', err.message);
  console.warn('  Add hooks manually — see README.md for the full config snippet.');
}

console.log('\nAll done. Start the dashboard with: npm start');
