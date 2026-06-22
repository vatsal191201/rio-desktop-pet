#!/usr/bin/env node
// rio-hook.js — a tiny bridge that tells Rio what Claude Code is doing.
//
// Claude Code runs this from its hooks. It reads the hook JSON on stdin (and/or
// accepts a state as the first CLI arg) and POSTs it to Rio's local server.
//
//   node rio-hook.js <state> [--port 4279]
//   echo '{...}' | node rio-hook.js          (state inferred from hook_event_name)
//
// It never blocks Claude Code: failures are swallowed and it always exits 0.
const http = require('http');

const args = process.argv.slice(2);
let port = 4279, stateArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = parseInt(args[++i], 10) || port;
  else if (!args[i].startsWith('--')) stateArg = args[i];
}

function send(payload) {
  const body = JSON.stringify(payload);
  const req = http.request(
    { host: '127.0.0.1', port, path: '/agent-state', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 600 },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
}

// Map Claude Code hook event names -> Rio states.
function stateFromEvent(name) {
  switch (name) {
    case 'UserPromptSubmit': case 'PreToolUse': return 'thinking';
    case 'PostToolUse': return 'thinking';
    case 'Stop': case 'SubagentStop': return 'done';
    case 'Notification': return 'notification';
    case 'SessionStart': return 'session';
    case 'SessionEnd': return 'idle';
    default: return 'thinking';
  }
}

let stdin = '';
const tryStdin = !process.stdin.isTTY;
if (tryStdin) process.stdin.on('data', (c) => (stdin += c));
const finish = () => {
  let hook = {};
  try { hook = JSON.parse(stdin || '{}'); } catch {}
  const state = stateArg || stateFromEvent(hook.hook_event_name || '');
  const message = hook.message || (hook.tool_name ? hook.tool_name : '') || '';
  send({ state, message, tool: hook.tool_name || '' });
};
if (tryStdin) { process.stdin.on('end', finish); setTimeout(finish, 250); }
else finish();
