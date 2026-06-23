// main.js — Rio the desktop dog. Owns the window, the brain, and the world.
//
// Architecture: MAIN is the brain + muscle (window position, locomotion,
// behaviour state machine, global cursor, click-through, drag physics, tray,
// the Claude Code agent server). The RENDERER is the body (it turns the
// current behaviour state + cursor into Rio's animated pixels). They talk over
// a tiny IPC surface defined in preload.js.

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, globalShortcut, shell, systemPreferences } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const DEV = process.argv.includes('--dev');
const log = (...a) => { if (DEV) console.log('[rio]', ...a); };

// ---------------------------------------------------------------------------
// Single-instance lock (must be first).
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (petWin) summon(); });

// ---------------------------------------------------------------------------
// Settings (persisted to userData).
// ---------------------------------------------------------------------------
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'rio-settings.json');
const DEFAULTS = {
  name: 'friend', scale: 1.5, mute: true, followCursor: true,
  biteCursor: true, reactKeyboard: true, stretchEvery: 25, cape: true,
  agentEnabled: true, agentPort: 4279, accessPrompted: false,
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) }; }
  catch { settings = { ...DEFAULTS }; }
  // validate (a garbled file with scale:0/NaN would make a 0-size window)
  if (![1, 1.5, 2, 3].includes(settings.scale)) settings.scale = 1.5;
  if (!Number.isInteger(settings.agentPort) || settings.agentPort < 1024 || settings.agentPort > 65535) settings.agentPort = 4279;
  if (!Number.isFinite(settings.stretchEvery) || settings.stretchEvery < 0) settings.stretchEvery = 25;
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (e) { log('save fail', e); }
}

// ---------------------------------------------------------------------------
// Geometry.
// ---------------------------------------------------------------------------
const BUF_W = 72, BUF_H = 60, BASE_ROW = 50;   // Rio's internal pixel buffer (see rio.js)
// margins around the buffer give room for the speech bubble, the throw tumble
// (the sprite rotates), dangling feet, and the landing dust — without clipping.
const MARGIN_X = 20, MARGIN_TOP = 24, MARGIN_BOT = 14;
function winSize() {
  const s = settings.scale;
  return { w: Math.round((BUF_W + 2 * MARGIN_X) * s), h: Math.round((BUF_H + MARGIN_TOP + MARGIN_BOT) * s) };
}
// the window hangs below the floor by this much so Rio's feet rest exactly on it
function feetOverhang() { return Math.round((BUF_H - BASE_ROW + MARGIN_BOT) * settings.scale); }
function roamRange() {
  const ds = screen.getAllDisplays();
  return {
    min: Math.min(...ds.map(d => d.workArea.x)),
    max: Math.max(...ds.map(d => d.workArea.x + d.workArea.width)),
  };
}
// Snap a desired window-center onto a REAL display and floor-align it. We pick
// the display nearest the dog's FEET point, which correctly handles every
// monitor arrangement — side-by-side, vertically stacked, mixed sizes, mixed
// scale factors, and gaps. The center X is then clamped inside that display's
// work area, and the window Y is set so Rio's feet rest on that display's floor
// (above its Dock/menu bar). As Rio walks past a shared edge his feet point
// moves into the next monitor and he steps onto its floor — no getting stuck,
// no sliding into dead space between monitors.
function placeForCenter(centerX, feetY, w, h) {
  w = w || brain.w; h = h || brain.h;
  // never let a non-finite input reach the OS (it crashes setPosition)
  if (!Number.isFinite(centerX)) centerX = (brain && Number.isFinite(brain.x)) ? brain.x + w / 2 : screen.getPrimaryDisplay().workArea.x + w;
  if (!Number.isFinite(feetY)) feetY = (brain && Number.isFinite(brain.y)) ? brain.y + h : screen.getPrimaryDisplay().workArea.y + h;
  const disp = screen.getDisplayNearestPoint({ x: Math.round(centerX), y: Math.round(feetY) });
  const wa = disp.workArea;
  const cx = Math.max(wa.x + w / 2, Math.min(wa.x + wa.width - w / 2, centerX));
  return { x: cx - w / 2, y: wa.y + wa.height - h + feetOverhang(), disp, wa };
}

// ---------------------------------------------------------------------------
// The brain.
// ---------------------------------------------------------------------------
let petWin = null;
let brain = null;
let rendererErrors = 0;   // counts exceptions surfaced from the renderer
let recoveries = 0;       // counts non-finite-position auto-recoveries
function newBrain() {
  const { w, h } = winSize();
  const sp = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(sp).workArea;
  const startX = Math.max(wa.x, Math.min(wa.x + wa.width - w, sp.x - w / 2));
  const y = wa.y + wa.height - h + feetOverhang();
  return {
    w, h,
    x: startX, y,
    vy: 0, vx: 0, falling: false, bounces: 0,
    angle: 0, angVel: 0,            // tumble while airborne
    svx: 0, svy: 0,                 // smoothed cursor velocity (for throw release)
    state: 'idle', stateTime: 0, hold: 0,    // hold = ms to stay before re-deciding
    facing: 1,
    targetX: null, speed: 0,
    mood: 0.7, energy: 1,
    nextDecision: 2200,
    cursor: { x: sp.x, y: sp.y, vx: 0, vy: 0, speed: 0 },
    hitbox: null,
    dragging: false, dragOffset: { x: 0, y: 0 },
    ignore: true,        // current click-through state
    bubble: '', bubbleUntil: 0,
    agent: null, agentUntil: 0,
    zoomDir: 1, zoomLeft: 0,
    lastBite: 0, keyUntil: 0, keyHot: false, scrollUntil: 0, lastScrollSpin: 0, spinFlip: 0,
    settledUntil: 0,                // stays put after being placed (move out of the way)
    overDog: false, wasOverDog: false, cursorDist: 9999, lastHoverPet: 0,
    lastSentState: '', lastBubbleSent: '',
  };
}

// states that are "busy" — autonomous decisions & cursor-chase are suppressed
const RESTING = new Set(['sit', 'nap', 'sleep', 'scratch', 'sniff', 'paw', 'rollover', 'think', 'pet',
  'beg', 'stretch', 'playbow', 'dig', 'type', 'overheat', 'spin', 'read']);
const ONESHOT = new Set(['bark', 'paw', 'rollover', 'land', 'bite', 'shake']);   // play once, then resolve

function setState(s, hold) {
  if (brain.state === s && !ONESHOT.has(s)) { if (hold) brain.hold = hold; return; }
  brain.state = s;
  brain.stateTime = 0;
  brain.hold = hold || 0;
  pushState();
}
function say(text, ms = 2600) { brain.bubble = text; brain.bubbleUntil = Date.now() + ms; pushState(); }

function pushState() {
  if (!petWin || petWin.isDestroyed()) return;
  const showBubble = Date.now() < brain.bubbleUntil ? brain.bubble : '';
  petWin.webContents.send('rio:state', {
    state: brain.state, facing: brain.facing, mood: brain.mood, energy: brain.energy,
    bubble: showBubble, name: settings.name, agent: brain.agent,
  });
}

// ---------------------------------------------------------------------------
// Window.
// ---------------------------------------------------------------------------
function createWindow() {
  const { w, h } = winSize();
  brain = newBrain();
  petWin = new BrowserWindow({
    width: w, height: h,
    x: Math.round(brain.x), y: Math.round(brain.y),
    transparent: true, frame: false, hasShadow: false, roundedCorners: false,
    resizable: false, movable: true, skipTaskbar: true,
    focusable: false, fullscreenable: false, minimizable: false, maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  petWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  petWin.setAlwaysOnTop(true, 'screen-saver');
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  petWin.setIgnoreMouseEvents(true, { forward: true });
  brain.ignore = true;
  if (DEV) petWin.webContents.openDevTools({ mode: 'detach' });
  petWin.on('closed', () => { petWin = null; });
}

function rebuildWindow() {
  // size changes recreate the window (resizing a transparent macOS window is buggy).
  // End any in-progress drag/throw first so the new brain doesn't strand him.
  if (brain && (brain.dragging || brain.falling)) { brain.dragging = false; brain.falling = false; }
  const old = petWin;
  const keepX = (brain && Number.isFinite(brain.x)) ? brain.x : undefined;
  createWindow();
  if (keepX != null) { const p = placeForCenter(keepX + brain.w / 2, brain.y + brain.h); brain.x = p.x; brain.y = p.y; }
  if (old && !old.isDestroyed()) old.destroy();
}

// ---------------------------------------------------------------------------
// Cursor + main loop (~60fps).
// ---------------------------------------------------------------------------
let lastT = 0;
function loop() {
  const now = Date.now();
  let dt = lastT ? now - lastT : 16;
  lastT = now;
  dt = Math.min(dt, 50);
  if (!petWin || petWin.isDestroyed() || !brain) return;

  // cursor + velocity
  const p = screen.getCursorScreenPoint();
  const c = brain.cursor;
  const ndt = Math.max(1, dt) / 1000;
  c.vx = (p.x - c.x) / ndt; c.vy = (p.y - c.y) / ndt;
  c.speed = Math.hypot(c.vx, c.vy);
  c.x = p.x; c.y = p.y;
  // smoothed cursor velocity — the basis for "throw" strength on release
  if (!Number.isFinite(c.vx)) c.vx = 0; if (!Number.isFinite(c.vy)) c.vy = 0;
  brain.svx = brain.svx * 0.6 + c.vx * 0.4;
  brain.svy = brain.svy * 0.6 + c.vy * 0.4;
  if (!Number.isFinite(brain.svx)) brain.svx = 0;
  if (!Number.isFinite(brain.svy)) brain.svy = 0;

  think(dt);
  applyMovement(dt);
  updateClickThrough();
  sendTick();

  // auto-clear the speech bubble the instant it expires (otherwise the renderer
  // would keep showing a stale bubble until the next state change)
  const effBubble = now < brain.bubbleUntil ? brain.bubble : '';
  if (effBubble !== brain.lastBubbleSent) { brain.lastBubbleSent = effBubble; pushState(); }

  brain.stateTime += dt;
}

// behaviour state machine -----------------------------------------------------
function think(dt) {
  const b = brain;

  // 1) Dragging always wins.
  if (b.dragging) {
    b.x = b.cursor.x - b.dragOffset.x;
    b.y = b.cursor.y - b.dragOffset.y;
    if (Math.abs(b.svx) > 60) b.facing = b.svx >= 0 ? 1 : -1;   // face the flight direction
    if (b.state !== 'drag') setState('drag');
    return;
  }

  // 2) Falling / being thrown — projectile physics, tumble, and bounces.
  if (b.falling) {
    const dts = dt / 1000;
    b.vy += 3000 * dts;                 // gravity
    b.vx *= (1 - 1.1 * dts);            // air drag on horizontal throw
    b.x += b.vx * dts;
    b.y += b.vy * dts;
    b.angle += b.angVel * dts;          // tumble
    b.angVel *= (1 - 0.8 * dts);
    // bounce off the left/right edges of the whole desktop
    const range = roamRange();
    if (range.max - range.min <= b.w) { b.vx = 0; b.x = range.min; }   // no room to bounce
    else if (b.x < range.min) { b.x = range.min; b.vx = Math.abs(b.vx) * 0.5; b.angVel = -b.angVel * 0.6; if (b.stateTime > 120) say('bonk!', 700); }
    else if (b.x > range.max - b.w) { b.x = range.max - b.w; b.vx = -Math.abs(b.vx) * 0.5; b.angVel = -b.angVel * 0.6; if (b.stateTime > 120) say('bonk!', 700); }
    // floor of the display under him
    const fp = placeForCenter(b.x + b.w / 2, b.y + b.h);
    if (b.y >= fp.y) {
      if (b.vy > 820 && b.bounces < 1) {   // one cartoony bounce on a hard landing
        b.y = fp.y; b.vy = -b.vy * 0.34; b.vx *= 0.5; b.angVel *= 0.3; b.bounces++;
      } else {                              // settle
        b.y = fp.y; b.x = fp.x; b.vx = 0; b.vy = 0; b.angVel = 0; b.angle = 0; b.bounces = 0; b.falling = false;
        setState('land', 420);
        b.settledUntil = now() + 22000;     // stay here a while (out of the way)
        say(pick(['oof!', '*tippy taps*', "i'll stay here", 'whee!', 'comfy spot']), 1600);
      }
    }
    return;
  }

  // 3) Agent (Claude Code) override.
  if (b.agent && now() < b.agentUntil) { agentThink(dt); return; }
  if (b.agent && now() >= b.agentUntil) { b.agent = null; setState('idle'); }

  // 4) One-shot actions resolve after their hold.
  if (ONESHOT.has(b.state)) {
    if (b.stateTime >= b.hold) setState(b.energy > 0.4 ? 'idle' : 'sit');
    return;
  }

  // 4.0) Stay put after being placed — dropping him is how you move him out of
  // the way, so he sits where he landed and won't wander/chase/bite until the
  // timer runs out or you interact with him (pet/poke/grab clears it).
  if (now() < b.settledUntil) {
    if (b.state !== 'sit') setState('sit', Math.max(1500, b.settledUntil - now()));
    return;
  }

  // 4a) Spin (chasing his tail / reacting to a scroll) — flip facing then settle.
  if (b.state === 'spin') {
    if (b.stateTime >= 1100) { setState('idle', 600); }
    else if (now() - b.spinFlip > 110) { b.facing *= -1; b.spinFlip = now(); pushState(); }
    return;
  }

  // 4b) Jump-bite — the cursor got too close, so Rio leaps up and snaps at it.
  if (settings.biteCursor && !RESTING.has(b.state) && b.state !== 'bite' && b.state !== 'come') {
    const hx = headCenterX(), hy = b.y + b.h * 0.42;
    const d = Math.hypot(b.cursor.x - hx, b.cursor.y - hy);
    if (d < 48 && now() - b.lastBite > 850) {
      b.lastBite = now();
      b.facing = (b.cursor.x >= centerX()) ? 1 : -1;
      setState('bite', 440);
      if (Math.random() < 0.5) say(pick(['nom!', 'gotcha!', 'grr!', 'mine!']), 1100);
      return;
    }
  }

  // 4c) Typing reaction (needs the optional input hook) — tap along, overheat if fast.
  if (now() < b.keyUntil && !RESTING.has(b.state)) { setState(b.keyHot ? 'overheat' : 'type'); return; }
  if ((b.state === 'type' || b.state === 'overheat') && now() >= b.keyUntil) setState('idle');

  // 4d) Scrolling -> Rio puts on reading glasses and flips through a book.
  if (now() < b.scrollUntil && !b.dragging) {
    if (b.state !== 'read') { setState('read'); say(pick(['hmm…', 'interesting', 'page-turner!', '*flip flip*']), 2000); }
    b.hold = (b.scrollUntil - now()) + 300;
    return;
  }
  if (b.state === 'read') setState('idle');

  // 5) Cursor chase — fast movement near Rio makes him give chase.
  if (settings.followCursor && !RESTING.has(b.state) && b.state !== 'come') {
    const dist = Math.abs(b.cursor.x - centerX());
    if (b.cursor.speed > 900 && dist < 520 && dist > 60) {
      b.targetX = b.cursor.x - b.w / 2;
      setState('chase');
      b.nextDecision = 700;
      return;
    }
  }

  // 6) Active locomotion.
  if (b.state === 'chase') {
    b.targetX = b.cursor.x - b.w / 2;
    if (Math.abs(b.x - b.targetX) < 8 || b.cursor.speed < 250) {
      // caught up / cursor settled
      setState(Math.random() < 0.5 ? 'sit' : 'idle', 1500);
      if (Math.random() < 0.4) { setState('bark', 360); }
    }
    return;
  }
  if (b.state === 'walk' || b.state === 'come') {
    if (b.targetX == null || Math.abs(b.x - b.targetX) < 6) {
      b.targetX = null;
      setState(b.state === 'come' ? 'sit' : 'idle', b.state === 'come' ? 4000 : 1200);
    }
    return;
  }
  if (b.state === 'celebrate') { celebrate(dt); return; }

  // 7) Autonomous life — pick a new little action now and then.
  b.nextDecision -= dt;
  if (b.hold > 0) { b.hold -= dt; if (b.hold > 0) return; }
  if (b.nextDecision <= 0) decide();
}

function decide() {
  const b = brain;
  b.nextDecision = 2600 + Math.random() * 4200;
  // gentle energy drift: resting restores, activity drains
  const r = Math.random();
  const tired = b.energy < 0.35;
  if (tired) {
    // wind down to a nap
    b.energy = Math.min(1, b.energy + 0.05);
    setState(Math.random() < 0.6 ? 'nap' : 'sleep', 6000 + Math.random() * 8000);
    if (Math.random() < 0.5) say('zzz...', 3000);
    return;
  }
  if (RESTING.has(b.state)) { b.energy = Math.min(1, b.energy + 0.08); }
  if (r < 0.26) {                 // wander
    const range = roamRange();
    const span = 160 + Math.random() * 320;
    let tx = b.x + (Math.random() < 0.5 ? -span : span);
    tx = Math.max(range.min, Math.min(range.max - b.w, tx));
    b.targetX = tx; setState('walk'); b.energy = Math.max(0, b.energy - 0.08);
  } else if (r < 0.40) { setState('sit', 3000 + Math.random() * 4000); }
  else if (r < 0.49) { setState('sniff', 2200); }
  else if (r < 0.57) { setState('scratch', 1800); }
  else if (r < 0.65) { setState('nap', 7000 + Math.random() * 8000); }
  else if (r < 0.71) { setState('stretch', 3200); say(pick(['*big stretch*', 'mmmf~']), 2200); }
  else if (r < 0.77) { setState('playbow', 2400); say(pick(["let's play!", 'play with me?']), 2200); }
  else if (r < 0.82) { setState('beg', 2600); say(pick(['treat? 🦴', 'pretty please?']), 2400); }
  else if (r < 0.87) { setState('dig', 2200); say(pick(['dig dig dig', '*scratch scratch*']), 1800); }
  else if (r < 0.91) { setState('idle', 2400); b.facing = Math.random() < 0.5 ? 1 : -1; pushState(); }
  else if (r < 0.96) { setState('rollover', 2600); say(pick(['rub my belly?', '<3']), 2400); }
  else { setState('bark', 360); say('woof!', 1200); }
}

function celebrate(dt) {
  const b = brain;
  if (b.zoomLeft <= 0) { setState('sit', 1800); say(pick(['nice!!', 'we did it!', '*zoomies*']), 2200); return; }
  b.zoomLeft -= dt;
  // dash back and forth
  if (b.targetX == null || Math.abs(b.x - b.targetX) < 12) {
    const range = roamRange();
    b.zoomDir *= -1;
    let tx = b.x + b.zoomDir * (180 + Math.random() * 120);
    tx = Math.max(range.min, Math.min(range.max - b.w, tx));
    b.targetX = tx;
  }
}

function agentThink(dt) {
  const b = brain;
  const a = b.agent;
  if (a.kind === 'think') {
    if (b.state !== 'think') setState('think');
  } else if (a.kind === 'celebrate') {
    if (b.state !== 'celebrate') { setState('celebrate'); b.zoomLeft = 1500; b.targetX = null; }
    celebrate(dt);
  } else if (a.kind === 'alert') {
    if (b.state !== 'bark') setState('bark', 420);
  } else if (a.kind === 'greet') {
    if (b.state !== 'pet') setState('pet', 1800);
  } else if (a.kind === 'whine') {
    if (b.state !== 'sit') setState('sit', 2000);
  }
}

// movement application --------------------------------------------------------
function applyMovement(dt) {
  const b = brain;
  if (!b.dragging && !b.falling) {
    // horizontal locomotion toward target
    const moving = (b.state === 'walk' || b.state === 'come' || b.state === 'chase' || b.state === 'celebrate');
    if (moving && b.targetX != null) {
      const spd = (b.state === 'chase' || b.state === 'celebrate') ? 360 : 92; // px/s
      const dir = Math.sign(b.targetX - b.x) || 1;
      b.facing = dir >= 0 ? 1 : -1;
      const step = spd * (dt / 1000);
      if (Math.abs(b.targetX - b.x) <= step) b.x = b.targetX; else b.x += dir * step;
    }
    // place him on a real display and keep his feet on that display's floor
    const p = placeForCenter(b.x + b.w / 2, b.y + b.h);
    b.x = p.x; b.y = p.y;
  }
  // last line of defence: if anything ever produced a non-finite position,
  // recover to a safe on-screen spot instead of crashing setPosition.
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) {
    const wa = screen.getPrimaryDisplay().workArea;
    b.x = wa.x + Math.round(wa.width / 2 - b.w / 2);
    b.y = wa.y + wa.height - b.h + feetOverhang();
    b.vx = 0; b.vy = 0; b.svx = 0; b.svy = 0; b.angle = 0; b.angVel = 0;
    b.falling = false; b.dragging = false;
    recoveries++;
  }
  petWin.setPosition(Math.round(b.x), Math.round(b.y));
}

// click-through toggle + hover reactions (using the global cursor vs the dog's
// hitbox — reliable, doesn't depend on the renderer receiving DOM mouse events).
function updateClickThrough() {
  const b = brain;
  let over = false, dist = 9999;
  if (b.hitbox) {
    const lx = b.cursor.x - b.x, ly = b.cursor.y - b.y; // cursor in window CSS px
    const hb = b.hitbox;
    over = lx >= hb.x && lx <= hb.x + hb.w && ly >= hb.y && ly <= hb.y + hb.h;
    // distance from the cursor to the dog's box (0 when inside) — for "near" reactions
    const ddx = Math.max(hb.x - lx, 0, lx - (hb.x + hb.w));
    const ddy = Math.max(hb.y - ly, 0, ly - (hb.y + hb.h));
    dist = Math.hypot(ddx, ddy);
  }
  b.overDog = over; b.cursorDist = dist;

  const wantIgnore = !over && !b.dragging;
  if (wantIgnore !== b.ignore) {
    b.ignore = wantIgnore;
    petWin.setIgnoreMouseEvents(wantIgnore, wantIgnore ? { forward: true } : undefined);
  }

  // ---- hover / pet reactions ----
  if (!b.dragging && !b.falling) {
    if (over) {
      // stroking him (cursor moving over the dog) makes him happy
      if (b.cursor.speed > 22 && now() - b.lastHoverPet > 80) {
        b.lastHoverPet = now();
        b.mood = Math.min(1, b.mood + 0.02);
        b.settledUntil = 0;
        if (!RESTING.has(b.state) || ['sit', 'idle', 'walk', 'pet', 'look'].includes(b.state)) setState('pet', 1100);
        if (Math.random() < 0.01) say(pick(['<3', '*happy*', 'arf!', 'hehe']), 1400);
      } else if (!b.wasOverDog && ['idle', 'sit', 'walk'].includes(b.state)) {
        setState('pet', 900);     // just hovered onto him -> notices you
      }
    } else if (dist < 130 && !RESTING.has(b.state) && b.state !== 'pet') {
      // cursor NEAR him -> turn to face it & perk up (handled in the renderer too)
      b.facing = (b.cursor.x >= centerX()) ? 1 : -1;
    }
  }
  b.wasOverDog = over;
}

function sendTick() {
  const b = brain;
  petWin.webContents.send('rio:tick', {
    cx: b.cursor.x - b.x, cy: b.cursor.y - b.y, speed: b.cursor.speed,
    dragging: b.dragging, airborne: b.falling, angle: b.angle,
    vmag: Math.hypot(b.vx, b.vy),
    over: b.overDog, near: Math.max(0, Math.min(1, 1 - b.cursorDist / 130)),
    // drag velocity drives the flying lean + cape stream
    dvx: b.dragging ? b.svx : b.vx, dvy: b.dragging ? b.svy : b.vy,
  });
}

// helpers
function now() { return Date.now(); }
function centerX() { return brain.x + brain.w / 2; }
function headCenterX() { return brain.x + brain.w / 2 + brain.facing * (brain.w * 0.18); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

// ---------------------------------------------------------------------------
// Drag (custom, via global cursor — robust through click-through).
// ---------------------------------------------------------------------------
ipcMain.on('rio:drag-start', () => {
  if (!brain) return;
  const c = screen.getCursorScreenPoint();
  brain.dragging = true;
  brain.dragOffset = { x: c.x - brain.x, y: c.y - brain.y };
  brain.agent = null;
  brain.settledUntil = 0;
  petWin.setIgnoreMouseEvents(false);
  brain.ignore = false;
  setState('drag');
});
ipcMain.on('rio:drag-end', () => {
  if (!brain || !brain.dragging) return;
  brain.dragging = false;
  // fling him with the cursor's release velocity — a flick throws him across the
  // screen; a gentle let-go just drops him. He always falls to the floor.
  brain.vx = Math.max(-2400, Math.min(2400, brain.svx * 0.9));
  brain.vy = Math.max(-1400, Math.min(1700, brain.svy * 0.9));
  brain.angVel = Math.max(-14, Math.min(14, brain.vx / 130)); // tumble with the throw
  brain.bounces = 0;
  brain.falling = true;
  brain.mood = Math.min(1, brain.mood + 0.05);
  setState('fall');
  if (Math.hypot(brain.vx, brain.vy) > 1400) say(pick(['wheeee!', 'aaah!', 'yeet!']), 1200);
});

// ---------------------------------------------------------------------------
// Renderer intents.
// ---------------------------------------------------------------------------
ipcMain.on('rio:ready', () => { pushConfig(); pushState(); });
ipcMain.on('rio:hitbox', (_e, rect) => { if (brain) brain.hitbox = rect; });
ipcMain.on('rio:action', (_e, { name, data }) => handleAction(name, data));
ipcMain.on('rio:error', (_e, msg) => { rendererErrors++; console.error('[renderer]', msg); });
ipcMain.handle('rio:get-config', () => configPayload());

function configPayload() {
  const { w, h } = winSize();
  return { name: settings.name, scale: settings.scale, mute: settings.mute, w, h, cape: settings.cape };
}
function pushConfig() { if (petWin && !petWin.isDestroyed()) petWin.webContents.send('rio:config', configPayload()); }

function handleAction(name, data) {
  const b = brain; if (!b) return;
  b.settledUntil = 0;          // any direct interaction ends the "stay" early
  switch (name) {
    case 'pet':                                   // renderer detected head-petting
      b.mood = Math.min(1, b.mood + 0.04);
      if (!RESTING.has(b.state) || b.state === 'sit' || b.state === 'idle') setState('pet', 1400);
      if (Math.random() < 0.012) say(pick(['<3', '*happy*', 'arf!']), 1500);
      break;
    case 'bark': setState('bark', 360); say('woof!', 1100); break;
    case 'paw': setState('paw', 1600); say(pick(['paw!', '*shake*']), 1800); break;
    case 'doubleclick': setState('bark', 380); say(pick(['woof woof!', 'borf!']), 1200); break;
    case 'poke': if (!b.dragging) { setState('idle', 800); b.facing = (data && data.fromLeft) ? 1 : -1; pushState(); } break;
  }
}

// ---------------------------------------------------------------------------
// Tray menu commands.
// ---------------------------------------------------------------------------
function cmdCome() {
  if (!brain) return;
  const c = screen.getCursorScreenPoint();
  brain.targetX = c.x - brain.w / 2; brain.agent = null; brain.settledUntil = 0; setState('come');
}
function rebuildTray() {
  if (!tray) return;
  const m = Menu.buildFromTemplate([
    { label: `🐾 Rio`, enabled: false },
    { type: 'separator' },
    { label: 'Come here', click: cmdCome },
    { label: 'Tricks', submenu: [
      { label: 'Sit', click: () => { brain.agent = null; setState('sit', 6000); } },
      { label: 'Lie down / nap', click: () => { brain.agent = null; setState('nap', 12000); say('zzz...', 3000); } },
      { label: 'Give paw', click: () => { brain.agent = null; setState('paw', 1800); say('paw!', 1800); } },
      { label: 'Beg', click: () => { brain.agent = null; setState('beg', 3000); say(pick(['treat? 🦴', 'pretty please?']), 2400); } },
      { label: 'Roll over', click: () => { brain.agent = null; setState('rollover', 2800); say('<3', 2400); } },
      { label: 'Play bow', click: () => { brain.agent = null; setState('playbow', 2600); say("let's play!", 2200); } },
      { label: 'Spin', click: () => { brain.agent = null; brain.spinFlip = now(); setState('spin'); } },
      { label: 'Shake off', click: () => { brain.agent = null; setState('shake', 720); } },
      { label: 'Dig', click: () => { brain.agent = null; setState('dig', 2400); say('dig dig dig', 1800); } },
      { label: 'Stretch', click: () => { brain.agent = null; setState('stretch', 3200); say('*big stretch*', 2200); } },
      { label: 'Speak!', click: () => { brain.agent = null; setState('bark', 360); say('woof!', 1200); } },
      { label: 'Zoomies!', click: () => { brain.agent = null; setState('celebrate'); brain.zoomLeft = 2200; brain.targetX = null; } },
    ] },
    { type: 'separator' },
    { label: 'Follow the cursor', type: 'checkbox', checked: settings.followCursor,
      click: (mi) => { settings.followCursor = mi.checked; saveSettings(); } },
    { label: 'Bite at the cursor', type: 'checkbox', checked: settings.biteCursor,
      click: (mi) => { settings.biteCursor = mi.checked; saveSettings(); } },
    { label: 'React to typing', type: 'checkbox', checked: settings.reactKeyboard,
      click: (mi) => { settings.reactKeyboard = mi.checked; saveSettings(); restartInputHooks(); rebuildTray();
        if (mi.checked && !accessibilityTrusted()) grantAccessibility(); } },
    { label: 'Super cape 🦸', type: 'checkbox', checked: settings.cape,
      click: (mi) => { settings.cape = mi.checked; saveSettings(); pushConfig(); } },
    ...(settings.reactKeyboard && !accessibilityTrusted()
      ? [{ label: 'Grant typing access…', click: grantAccessibility }] : []),
    { label: 'Sounds', type: 'checkbox', checked: !settings.mute,
      click: (mi) => { settings.mute = !mi.checked; saveSettings(); pushConfig(); } },
    { label: 'React to Claude Code', type: 'checkbox', checked: settings.agentEnabled,
      click: (mi) => { settings.agentEnabled = mi.checked; saveSettings(); restartAgentServer(); } },
    { label: 'Size', submenu: [
      { label: 'Tiny', type: 'radio', checked: settings.scale === 1, click: () => setScale(1) },
      { label: 'Small', type: 'radio', checked: settings.scale === 1.5, click: () => setScale(1.5) },
      { label: 'Medium', type: 'radio', checked: settings.scale === 2, click: () => setScale(2) },
      { label: 'Large', type: 'radio', checked: settings.scale === 3, click: () => setScale(3) },
    ] },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { label: 'Hide Rio', click: () => { if (petWin) petWin.isVisible() ? petWin.hide() : summon(); } },
    { type: 'separator' },
    { label: 'Quit Rio', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(m);
}
function setScale(s) { settings.scale = s; saveSettings(); rebuildWindow(); rebuildTray(); pushConfig(); }

function summon() {
  if (!petWin || petWin.isDestroyed()) { createWindow(); return; }
  const c = screen.getCursorScreenPoint();
  const p = placeForCenter(c.x, c.y);
  brain.x = p.x; brain.y = p.y;
  brain.dragging = false; brain.falling = false;
  petWin.show();
  setState('pet', 1400); say(pick([`hi ${settings.name}!`, 'hello!', '*wag wag*']), 2200);
}

// ---------------------------------------------------------------------------
// Settings window.
// ---------------------------------------------------------------------------
let settingsWin = null;
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 600, title: 'Rio', resizable: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload-settings.js'), contextIsolation: true },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}
ipcMain.handle('rio:settings-get', () => ({ ...settings, port: settings.agentPort, appDir: path.join(__dirname, '..', '..'), accessTrusted: accessibilityTrusted() }));
ipcMain.handle('rio:grant-access', () => { grantAccessibility(); return { trusted: accessibilityTrusted() }; });
ipcMain.handle('rio:settings-set', (_e, patch) => {
  const sizeChanged = patch.scale != null && patch.scale !== settings.scale;
  settings = { ...settings, ...patch };
  saveSettings();
  if (sizeChanged) rebuildWindow();
  rebuildTray(); pushConfig(); pushState(); restartAgentServer(); restartInputHooks();
  return { ok: true };
});
ipcMain.on('rio:open-external', (_e, url) => shell.openExternal(url));

// ---------------------------------------------------------------------------
// Claude Code / AI agent integration — a tiny local HTTP server.
//   POST http://127.0.0.1:<port>/agent-state  {state, message, tool}
// ---------------------------------------------------------------------------
let agentServer = null;
function startAgentServer() {
  if (!settings.agentEnabled) return;
  agentServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(200); res.end('Rio is listening 🐾'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch {}
      onAgentEvent(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  agentServer.on('error', (e) => log('agent server error', e.code));
  agentServer.listen(settings.agentPort, '127.0.0.1', () => log('agent server on', settings.agentPort));
}
function restartAgentServer() {
  if (agentServer) { try { agentServer.close(); } catch {} agentServer = null; }
  startAgentServer();
}
function onAgentEvent(data) {
  if (!brain || !settings.agentEnabled) return;
  const s = String(data.state || data.event || '').toLowerCase();
  const msg = String(data.message || data.tool || '').replace(/[\r\n]+/g, ' ').slice(0, 64);  // sanitize + cap
  let kind = null, ttl = 8000, bubble = null;
  if (/(think|busy|work|run|tool|progress|start_tool|pretool)/.test(s)) { kind = 'think'; ttl = 90000; bubble = msg || 'thinking…'; }
  else if (/(done|stop|complete|finish|success|idle)/.test(s)) { kind = 'celebrate'; ttl = 4000; bubble = pick(['all done!', 'finished!', 'we did it!']); }
  else if (/(notif|wait|input|attention|permission|ask)/.test(s)) { kind = 'alert'; ttl = 6000; bubble = msg || 'your turn!'; }
  else if (/(error|fail|deny)/.test(s)) { kind = 'whine'; ttl = 5000; bubble = msg || 'uh oh…'; }
  else if (/(session|greet|hello|start$)/.test(s)) { kind = 'greet'; ttl = 4000; bubble = `hi ${settings.name}!`; }
  else { kind = 'think'; ttl = 8000; bubble = msg; }
  brain.agent = { kind };
  brain.agentUntil = now() + ttl;
  if (bubble) say(bubble, Math.min(ttl, 4000));
}

// ---------------------------------------------------------------------------
// Optional global input hooks (keyboard + scroll) via uiohook-napi.
// Needs macOS Accessibility permission; degrades gracefully if unavailable —
// Rio simply won't react to typing/scrolling if the module or permission is
// missing. Everything else keeps working.
// ---------------------------------------------------------------------------
let uio = null, uioOn = false, keyTimes = [];

// macOS Accessibility permission — global input taps stay silent without it.
function accessibilityTrusted() {
  if (process.platform !== 'darwin') return true;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return true; }
}
function promptAccessibility() {              // shows the system "grant access" dialog
  try { if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true); } catch {}
}
function openAccessibilitySettings() {
  try { shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); } catch {}
}
function grantAccessibility() { promptAccessibility(); openAccessibilitySettings(); }

function startInputHooks() {
  if (!settings.reactKeyboard || uioOn) return;
  try { uio = uio || require('uiohook-napi'); } catch { uio = null; return; }
  try {
    const u = uio.uIOhook;
    u.removeAllListeners && u.removeAllListeners();
    u.on('keydown', () => {
      if (!brain) return;
      const t = now(); keyTimes.push(t); keyTimes = keyTimes.filter(x => t - x < 1400);
      brain.keyUntil = t + 650;
      brain.keyHot = keyTimes.length >= 8;   // typing fast -> overheat
    });
    u.on('wheel', () => { if (brain && !brain.dragging) brain.scrollUntil = now() + 1100; });
    u.start();
    uioOn = true; log('input hooks on');
  } catch (e) { uioOn = false; log('input hooks failed', e && e.message); return; }
  // First time the feature runs without permission, walk the user through it once.
  if (process.platform === 'darwin' && !accessibilityTrusted() && !settings.accessPrompted) {
    settings.accessPrompted = true; saveSettings();
    if (brain) say("let me watch your typing? grant Accessibility 🐾", 6000);
    setTimeout(grantAccessibility, 900);
  }
}
function stopInputHooks() {
  try { if (uio && uioOn) { uio.uIOhook.removeAllListeners && uio.uIOhook.removeAllListeners(); uio.uIOhook.stop(); } } catch {}
  uioOn = false;
}
function restartInputHooks() { stopInputHooks(); startInputHooks(); }

// Watch for the permission being granted and switch the hooks on live (no restart).
let lastTrusted = false;
function watchAccessibility() {
  lastTrusted = accessibilityTrusted();
  setInterval(() => {
    if (process.platform !== 'darwin' || !settings.reactKeyboard) return;
    const t = accessibilityTrusted();
    if (t && !lastTrusted) { restartInputHooks(); if (brain) say('yay — now i feel your keystrokes! ⌨️', 3000); }
    lastTrusted = t;
  }, 3000);
}

// ---------------------------------------------------------------------------
// Tray + app lifecycle.
// ---------------------------------------------------------------------------
let tray = null;
function makeTray() {
  let img;
  const p = path.join(__dirname, '..', '..', 'assets', 'trayTemplate.png');
  try { img = nativeImage.createFromPath(p); } catch {}
  if (!img || img.isEmpty()) img = nativeImage.createEmpty();
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Rio — your desktop dog');
  rebuildTray();
}

app.whenReady().then(() => {
  loadSettings();
  app.setActivationPolicy?.('accessory');
  app.dock?.hide();
  createWindow();
  makeTray();
  startAgentServer();
  startInputHooks();
  watchAccessibility();
  setInterval(loop, 1000 / 60);

  // periodic stretch-break nudge — a literal downward dog to remind you too
  let lastStretch = Date.now();
  setInterval(() => {
    if (!brain || brain.dragging || brain.agent || petWin == null) return;
    if (settings.stretchEvery > 0 && Date.now() - lastStretch > settings.stretchEvery * 60000) {
      lastStretch = Date.now();
      setState('stretch', 4500);
      say(pick([`stretch time, ${settings.name}!`, "let's stretch together", 'take a break? 🐾']), 4000);
    }
  }, 30000);
  try {
    globalShortcut.register('CommandOrControl+Shift+D', () => { if (petWin && petWin.isVisible()) petWin.hide(); else summon(); });
  } catch {}
  // re-assert always-on-top occasionally (macOS can drop the level)
  setInterval(() => { if (petWin && !petWin.isDestroyed()) petWin.setAlwaysOnTop(true, 'screen-saver'); }, 4000);
  // recompute placement when monitors change (unplug/replug/resolution)
  const onDisplayChange = () => {
    if (!brain || !petWin || petWin.isDestroyed()) return;
    if (!brain.falling && !brain.dragging) {
      const p = placeForCenter(brain.x + brain.w / 2, brain.y + brain.h);
      brain.x = p.x; brain.y = p.y;
    } else {
      const r = roamRange();
      brain.x = Math.max(r.min, Math.min(r.max - brain.w, brain.x));
    }
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-added', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  // dev-only: capture frames to verify rendering, then quit.
  if (process.env.RIO_SHOTS) {
    const dir = process.env.RIO_SHOTS; let n = 0;
    const cap = (tag) => {
      if (!petWin || petWin.isDestroyed()) return;
      petWin.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(dir, `app_${String(++n).padStart(2, '0')}_${tag}.png`), img.toPNG());
      }).catch(() => {});
    };
    setTimeout(() => cap('launch'), 1400);
    setTimeout(() => { brain.dragging = true; brain.dragOffset = { x: 0, y: 0 }; brain.svx = 900; setState('drag'); }, 1800);
    setTimeout(() => cap('fly_grab'), 2120);                 // flying + panic (just grabbed)
    setTimeout(() => cap('fly_hero'), 3050);                 // panic faded, fast flight
    setTimeout(() => { brain.svx = 4; }, 3200);              // hover -> terrified leak
    setTimeout(() => cap('fly_hover'), 3650);
    setTimeout(() => { brain.dragging = false; brain.svx = 0; brain.scrollUntil = Date.now() + 4000; }, 4000);
    setTimeout(() => cap('read'), 4650);
    setTimeout(() => { brain.scrollUntil = 0; brain.dragging = false; brain.falling = true; brain.vx = 1300; brain.vy = -980; brain.angVel = 9; brain.bounces = 0; setState('fall'); }, 5050);
    setTimeout(() => cap('throw'), 5300);
    setTimeout(() => cap('landing'), 5750);
    setTimeout(() => cap('grounded'), 6600);     // settled — cape should be GONE
    setTimeout(() => { app.isQuitting = true; app.quit(); }, 7100);
  }

  // dev-only: automated STRESS HARNESS — hammers every code path with random
  // actions while asserting invariants, then prints a PASS/FAIL summary.
  if (process.env.RIO_STRESS) runStress();
});

function runStress() {
  const savedSettings = { ...settings };   // restore at the end — the harness must NOT persist random settings
  const ALL = ['idle', 'walk', 'come', 'chase', 'celebrate', 'sit', 'nap', 'sleep', 'scratch', 'sniff', 'paw',
    'beg', 'stretch', 'playbow', 'dig', 'rollover', 'bark', 'bite', 'type', 'overheat', 'spin', 'shake', 'think', 'pet', 'read'];
  const KNOWN = new Set([...ALL, 'drag', 'fall', 'land']);
  const dur = parseInt(process.env.RIO_STRESS, 10) > 1 ? parseInt(process.env.RIO_STRESS, 10) : 40000;
  let ticks = 0, driverErrs = 0, violations = 0, maxAbsX = 0;
  const visits = {};
  const startRss = process.memoryUsage().rss;
  const sample = []; sample.push(startRss);

  function bad(v) { return !Number.isFinite(v); }
  let nanSeen = 0;
  function assertInvariants() {
    const b = brain; if (!b) return;
    // injected/transient non-finite is recovered by applyMovement next frame —
    // count it but don't hard-fail (the whole point is it must NOT crash).
    if (bad(b.x) || bad(b.y) || bad(b.vx) || bad(b.vy) || bad(b.angle) || bad(b.svx) || bad(b.svy)) { nanSeen++; return; }
    const ds = screen.getAllDisplays();
    const minX = Math.min(...ds.map(d => d.workArea.x)) - 250;
    const maxX = Math.max(...ds.map(d => d.workArea.x + d.workArea.width)) + 250;
    if (b.x < minX || b.x > maxX) { violations++; console.error('[stress] x OUT OF BOUNDS', Math.round(b.x), [Math.round(minX), Math.round(maxX)]); }
    if (!KNOWN.has(b.state)) { violations++; console.error('[stress] UNKNOWN state', b.state); }
    if (petWin && petWin.isDestroyed()) { violations++; console.error('[stress] window DESTROYED'); }
    maxAbsX = Math.max(maxAbsX, Math.abs(b.x));
    visits[b.state] = (visits[b.state] || 0) + 1;
  }

  const driver = setInterval(() => {
    ticks++;
    try {
      const r = Math.random(), b = brain;
      if (!b) return;
      if (r < 0.24) setState(ALL[(Math.random() * ALL.length) | 0], 150 + Math.random() * 1200);
      else if (r < 0.40) {
        if (!b.dragging) { b.dragging = true; b.dragOffset = { x: 0, y: 0 }; b.settledUntil = 0; setState('drag'); }
        else { b.dragging = false; b.vx = (Math.random() - 0.5) * 6000; b.vy = (Math.random() - 0.6) * 3500; b.svx = b.vx; b.svy = b.vy; b.angVel = b.vx / 130; b.bounces = 0; b.falling = true; setState('fall'); }
      } else if (r < 0.50) b.scrollUntil = Date.now() + 700;
      else if (r < 0.62) onAgentEvent({ state: pick(['thinking', 'done', 'notification', 'error', 'session', 'garbage']), message: 'm'.repeat((Math.random() * 80) | 0) });
      else if (r < 0.72) { b.cursor.x += (Math.random() - 0.5) * 5000; b.cursor.y += (Math.random() - 0.5) * 4000; b.cursor.speed = Math.random() * 6000; }
      else if (r < 0.76) summon();
      else if (r < 0.80) { if (petWin && !petWin.isDestroyed()) { petWin.hide(); setTimeout(() => { if (petWin && !petWin.isDestroyed()) petWin.show(); }, 40); } }
      else if (r < 0.83) { settings.cape = !settings.cape; pushConfig(); }
      else if (r < 0.845) setScale([1, 1.5, 2, 3][(Math.random() * 4) | 0]); // rebuildWindow (heavy)
      else if (r < 0.87) { settings.mute = !settings.mute; pushConfig(); }
      else if (r < 0.88) handleAction(pick(['pet', 'poke', 'doubleclick', 'bark', 'paw']), { fromLeft: Math.random() < 0.5 });
      else if (r < 0.93) { const fld = pick(['x', 'y', 'svx', 'svy', 'vx', 'vy', 'angle']); b[fld] = Math.random() < 0.5 ? NaN : Infinity; } // inject non-finite to test recovery
    } catch (e) { driverErrs++; console.error('[stress] driver threw:', e && e.stack || e); }
    assertInvariants();
  }, 80);

  const mem = setInterval(() => sample.push(process.memoryUsage().rss), 2000);

  setTimeout(() => {
    clearInterval(driver); clearInterval(mem);
    const endRss = process.memoryUsage().rss;
    const grow = ((endRss - startRss) / 1048576);
    const pass = rendererErrors === 0 && driverErrs === 0 && violations === 0 && grow < 60;
    console.log('\n==================== STRESS SUMMARY ====================');
    console.log('duration(ms):', dur, 'ticks:', ticks);
    console.log('rendererErrors:', rendererErrors, ' driverErrors:', driverErrs, ' assertionViolations:', violations);
    console.log('non-finite injected/seen:', nanSeen, ' auto-recoveries:', recoveries, '(crash-fix proof: app survived)');
    console.log('rss MB start/end:', (startRss / 1048576) | 0, '/', (endRss / 1048576) | 0, ' growth:', grow.toFixed(1), 'MB');
    console.log('maxAbsX:', maxAbsX | 0, ' statesVisited:', Object.keys(visits).length, '/', ALL.length + 3);
    console.log('visits:', JSON.stringify(visits));
    console.log('RESULT:', pass ? 'PASS ✅' : 'FAIL ❌');
    console.log('=======================================================\n');
    settings = savedSettings; saveSettings();   // undo any settings the harness changed
    app.isQuitting = true; setTimeout(() => app.quit(), 300);
  }, dur);
}

app.on('window-all-closed', () => { /* tray app — keep running */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopInputHooks(); if (agentServer) try { agentServer.close(); } catch {} });
