#!/usr/bin/env node
// install-claude-hook.js — wires Rio into Claude Code by adding hooks to your
// ~/.claude/settings.json. Each hook runs rio-hook.js, which POSTs Rio's local
// server so Rio thinks-along, perks up for notifications, and celebrates when
// a task finishes.
//
//   node tools/install-claude-hook.js [--port 4279] [--uninstall]
//
// Safe & idempotent: it only touches a marked block of hook entries it owns and
// leaves the rest of your settings untouched. Re-run to update.
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
let port = 4279, uninstall = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = parseInt(args[++i], 10) || port;
  else if (args[i] === '--uninstall') uninstall = true;
}

const HOOK = path.join(__dirname, 'rio-hook.js');
const TAG = 'rio-desktop-pet';
const file = path.join(os.homedir(), '.claude', 'settings.json');

function cmdFor() { return `node "${HOOK}" --port ${port}`; }
function entry(event) {
  return { matcher: '*', __rio: TAG, hooks: [{ type: 'command', command: cmdFor(), timeout: 5 }] };
}
// Events Rio listens to.
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'Stop', 'SubagentStop', 'Notification', 'SessionStart'];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { settings = {}; }
settings.hooks = settings.hooks || {};

// strip any hooks we previously added (idempotent / uninstall)
for (const ev of Object.keys(settings.hooks)) {
  if (Array.isArray(settings.hooks[ev])) {
    settings.hooks[ev] = settings.hooks[ev].filter((h) => h && h.__rio !== TAG);
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
}

if (!uninstall) {
  for (const ev of EVENTS) {
    settings.hooks[ev] = settings.hooks[ev] || [];
    settings.hooks[ev].push(entry(ev));
  }
}

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(settings, null, 2));
console.log(uninstall ? '🐾 Rio hooks removed.' : `🐾 Rio is now wired into Claude Code (port ${port}).`);
console.log('   Settings:', file);
if (!uninstall) console.log('   Restart Claude Code (or open a new session) to activate.');
