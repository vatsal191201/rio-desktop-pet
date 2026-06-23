/*
 * pet.js — Rio's body. The main process decides WHICH behaviour Rio is in;
 * this renderer turns that behaviour (plus the live cursor) into smoothly
 * animated pixels via the Rio rig, handles direct pointer interaction when the
 * window is interactive, draws the speech bubble, and makes dog noises.
 */
(function () {
  'use strict';

  const BUF_W = 72, BUF_H = 60, BX = 37, BASE = 50;
  const MARGIN_X = 20, MARGIN_TOP = 24;   // must match main.js (room for bubble/tumble/dust)

  const canvas = document.getElementById('rio');
  const ctx = canvas.getContext('2d');
  const bubbleEl = document.getElementById('bubble');

  // offscreen low-res buffer that we draw Rio into, then blit scaled
  const buf = document.createElement('canvas');
  buf.width = BUF_W; buf.height = BUF_H;
  const bctx = buf.getContext('2d');

  let SCALE = 3, dpr = 1, drawScale = 3, offX = 0, offY = 0, Wc = 216, Hc = 214;

  function fit() {
    dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    Wc = Math.max(1, window.innerWidth); Hc = Math.max(1, window.innerHeight);  // guard 0-size (hidden window)
    SCALE = Wc / (BUF_W + 2 * MARGIN_X);   // may be fractional (e.g. 1.5); crisp on Retina
    drawScale = SCALE * dpr;
    canvas.width = Math.round(Wc * dpr);
    canvas.height = Math.round(Hc * dpr);
    canvas.style.width = Wc + 'px';
    canvas.style.height = Hc + 'px';
    offX = Math.round(canvas.width / 2 - BX * drawScale);
    offY = Math.round(MARGIN_TOP * drawScale);
    ctx.imageSmoothingEnabled = false;
    reportHitbox();
  }

  // Rio's interactive box in window CSS px (a bit generous), reported to main
  // so it can decide when to disable click-through.
  function reportHitbox() {
    const cssOffX = Wc / 2 - BX * SCALE;
    const cssOffY = MARGIN_TOP * SCALE;
    const x = cssOffX + 11 * SCALE, w = 44 * SCALE;
    const y = cssOffY + 8 * SCALE, h = 46 * SCALE;
    window.rio.reportHitbox({ x, y, w, h });
  }

  // ---- behaviour state coming from main -----------------------------------
  let S = { state: 'idle', facing: 1, mood: 0.7, energy: 1, bubble: '', name: 'friend', agent: null };
  let cursor = { cx: 0, cy: 0, speed: 0, dragging: false };

  // eased animation channels (lerp toward targets for smooth transitions)
  const A = {
    sit: 0, lie: 0, curl: 0, roll: 0, paw: 0, scratch: 0,
    mouth: 0, tongue: 0, ear: 0.35, headUp: 0, lift: 0, dangle: 0,
    stretch: 0, playbow: 0, beg: 0, dig: 0, overheat: 0,
    fly: 0, glasses: 0, book: 0,
    sx: 1, heart: 0, sparkle: 0, think: 0, run: 0,
  };
  function lerp(a, b, t) { return a + (b - a) * t; }

  function targetsFor(st) {
    // returns desired channel values for a state (procedural motion added later)
    const T = { sit: 0, lie: 0, curl: 0, roll: 0, paw: 0, scratch: 0, mouth: 0,
      tongue: 0, ear: 0.35, headUp: 0, lift: 0, dangle: 0, heart: 0, sparkle: 0, think: 0, run: 0,
      stretch: 0, playbow: 0, beg: 0, dig: 0, overheat: 0 };
    switch (st) {
      case 'walk': case 'come': T.ear = 0.25; T.mouth = 0.15; T.tongue = 0.2; break;
      case 'chase': case 'celebrate': T.run = 1; T.ear = 1; T.mouth = 0.6; T.tongue = 0.8; T.heart = st === 'celebrate' ? 0.4 : 0; break;
      case 'sit': T.sit = 1; T.ear = 0.3; T.mouth = 0.1; T.tongue = 0.15; break;
      case 'pet': T.sit = 0; T.ear = 0.45; T.mouth = 0.6; T.tongue = 0.85; T.heart = 0.7; break;
      case 'nap': T.curl = 1; T.ear = 0.6; break;
      case 'sleep': T.lie = 1; T.ear = 0.7; break;
      case 'scratch': T.sit = 1; T.scratch = 1; T.ear = 0.55; T.mouth = 0.25; T.tongue = 0.4; break;
      case 'sniff': T.headUp = -1; T.ear = 0.45; break;
      case 'paw': T.sit = 1; T.paw = 1; T.ear = 0.25; T.mouth = 0.35; T.tongue = 0.45; break;
      case 'beg': T.sit = 1; T.beg = 1; T.ear = 0.1; T.mouth = 0.5; T.tongue = 0.6; break;
      case 'stretch': T.stretch = 1; break;
      case 'playbow': T.playbow = 1; T.heart = 0.4; T.mouth = 0.5; T.tongue = 0.7; break;
      case 'dig': T.dig = 1; T.headUp = -0.7; T.ear = 0.4; break;
      case 'rollover': T.roll = 1; T.tongue = 0.7; T.mouth = 0.4; T.heart = 0.5; break;
      case 'bark': T.mouth = 1; T.tongue = 0.3; T.ear = -0.5; break;
      case 'bite': T.ear = -0.6; T.mouth = 0.3; T.tongue = 0.25; break;
      case 'type': T.sit = 1; T.dig = 0.55; T.headUp = -0.4; T.ear = -0.15; T.mouth = 0.1; break;
      case 'overheat': T.sit = 1; T.overheat = 1; T.mouth = 1; T.tongue = 1; T.ear = 0.5; break;
      case 'spin': T.ear = 0.6; T.mouth = 0.4; T.tongue = 0.5; break;
      case 'shake': T.ear = 0.8; T.mouth = 0.2; break;
      case 'think': T.sit = 1; T.think = 1; T.ear = -0.35; T.headUp = 0.4; break;
      case 'drag': T.fly = 1; T.ear = -0.7; T.tongue = 0.5; T.mouth = 0.4; break;     // SUPERMAN
      case 'read': T.sit = 1; T.glasses = 1; T.book = 1; T.ear = 0.25; T.headUp = -0.25; T.mouth = 0.05; break;
      case 'fall': T.ear = 0; T.mouth = 0.7; T.tongue = 0.6; T.dangle = 0; break;
      case 'land': T.ear = 0.5; T.mouth = 0.2; break;
      case 'idle': default: T.ear = 0.35; break;
    }
    return T;
  }

  // ---- timers & procedural motion -----------------------------------------
  let t = 0, blinkTimer = 1500 + Math.random() * 2500, blinking = 0;
  let legPhase = 0, lastState = '', stateEnter = 0, landSpring = 0, pawWave = 0, lastDt = 16, capeAmt = 0;

  function frame(ts) {
    try { frameBody(ts); }
    catch (e) { try { window.rio.logError('frame: ' + (e && e.stack || e)); } catch {} }
    requestAnimationFrame(frame);   // keep the loop alive even if a frame throws
  }
  function frameBody(ts) {
    const now = ts || 0;
    const dt = Math.min(50, frame._last ? now - frame._last : 16);
    frame._last = now; t += dt; lastDt = dt;

    if (S.state !== lastState) { onEnterState(S.state); lastState = S.state; stateEnter = t; }

    // ease channels toward targets
    const T = targetsFor(S.state);
    const k = 1 - Math.pow(0.001, dt / 1000);   // ~ time-based smoothing
    for (const key of ['sit', 'lie', 'curl', 'roll', 'paw', 'scratch', 'ear', 'headUp', 'lift', 'dangle',
      'think', 'run', 'stretch', 'playbow', 'beg', 'dig', 'overheat', 'fly', 'glasses', 'book']) {
      A[key] = lerp(A[key], T[key], Math.min(1, k * 1.7));
    }
    A.mouth = lerp(A.mouth, T.mouth, Math.min(1, k * 2.4));
    A.tongue = lerp(A.tongue, T.tongue, Math.min(1, k * 2.4));
    A.heart = lerp(A.heart, T.heart, Math.min(1, k * 1.4));

    // blink
    blinkTimer -= dt;
    if (blinking > 0) { blinking -= dt; }
    else if (blinkTimer <= 0) { blinking = 110; blinkTimer = 1800 + Math.random() * 3200; }

    // landing spring decays
    if (landSpring > 0) landSpring = Math.max(0, landSpring - dt);

    render();
  }

  // report any stray renderer exception to main (rAF + listeners swallow them)
  window.addEventListener('error', (e) => { try { window.rio.logError('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || '')); } catch {} });
  window.addEventListener('unhandledrejection', (e) => { try { window.rio.logError('reject: ' + (e.reason && e.reason.message || e.reason)); } catch {} });

  function onEnterState(st) {
    if (st === 'bark') { sound('bark'); }
    if (st === 'land') { landSpring = 420; }
    if (st === 'pet' && Math.random() < 0.4) sound('yip');
    if (st === 'celebrate') sound('bark');
    if (st === 'bite') sound('yip');
    if (st === 'paw') pawWave = 0;
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    bctx.clearRect(0, 0, BUF_W, BUF_H);
    bctx.imageSmoothingEnabled = false;

    const pose = window.Rio.defaultPose();
    pose.facing = S.facing >= 0 ? 1 : -1;

    // resting/special silhouettes
    pose.sit = A.sit; pose.lie = A.lie; pose.curl = A.curl; pose.rollOver = A.roll;
    pose.scratch = A.scratch; pose.scratchPhase = t / 55;
    pose.pawUp = A.paw * (0.8 + 0.2 * Math.sin(t / 170)); // little wave, held high
    pose.dangle = A.dangle;
    pose.ear = A.ear;
    pose.stretch = A.stretch; pose.playbow = A.playbow;
    pose.beg = A.beg;
    pose.dig = A.dig; pose.digPhase = t / 45;
    pose.overheat = A.overheat;
    pose.fly = A.fly; pose.glasses = A.glasses; pose.book = A.book;
    if (S.state === 'read') pose.bookFlip = (t / 240) % 1;

    // ---- cape: a FLIGHT cape — deploys when he takes off (dragged/thrown),
    //      furls away when he lands. ----
    const flyingNow = (S.state === 'drag' || cursor.airborne || S.state === 'fall' || A.fly > 0.1);
    const capeWant = (cfgCape && flyingNow) ? 1 : 0;
    capeAmt += (capeWant - capeAmt) * Math.min(1, lastDt / 130);   // ease in/out over ~130ms
    pose.cape = cfgCape; pose.capeAmt = capeAmt;
    pose.capeFx = -1; pose.capeFy = 0.1; pose.capeStream = 1;       // always streaming while shown

    // breathing / idle life
    const breathing = (S.state === 'idle' || S.state === 'sit') ? Math.sin(t / 620) * 0.6 : 0;
    pose.bob = breathing;

    // walk / run leg cycle, driven by how fast Rio is actually travelling
    const moving = (S.state === 'walk' || S.state === 'come' || S.state === 'chase' || S.state === 'celebrate');
    if (moving) {
      const runF = A.run;
      legPhase += lastDt / (runF > 0.5 ? 330 : 520);   // ms per gait cycle (frame-rate independent)
      pose.legPhase = (legPhase % 1 + 1) % 1;
      pose.step = 1 + runF * 0.35;
      pose.bob = -Math.abs(Math.sin(pose.legPhase * Math.PI * 2)) * (1 + runF);
      if (runF > 0.5) { pose.lift = 2.5; pose.sx = 1.1; pose.sy = 0.92; }
      pose.tail = Math.sin(t / 90) * (0.5 + runF * 0.5);
    } else {
      pose.step = 0;
      // happy tail wag when petted/standing-happy/celebrating
      const wag = (S.state === 'pet' || A.heart > 0.3) ? 1 : (S.state === 'sit' ? 0.35 : 0.2);
      pose.tail = Math.sin(t / (S.state === 'pet' ? 70 : 240)) * wag;
    }

    // panting mouth oscillation when tongue is out
    if (A.tongue > 0.3 && S.state !== 'bark') {
      pose.mouth = A.mouth * (0.7 + 0.3 * Math.sin(t / 120));
      pose.tongue = A.tongue * (0.85 + 0.15 * Math.sin(t / 120));
    } else { pose.mouth = A.mouth; pose.tongue = A.tongue; }

    // bark snap: a quick lunge + squash at state start
    if (S.state === 'bark') {
      const age = t - stateEnter;
      const k = Math.max(0, 1 - age / 320);
      pose.headDx = 2 * k; pose.sx = 1 + 0.06 * k; pose.sy = 1 - 0.06 * k;
      pose.mouth = age < 60 ? 0.2 : 1; // wind-up then open
    }

    // landing squash (a big splat that springs back)
    if (landSpring > 0) {
      const k = landSpring / 420;
      pose.sx = 1 + 0.26 * k; pose.sy = 1 - 0.26 * k;
    }

    // jump-bite: a quick upward lunge that snaps at the cursor
    if (S.state === 'bite') {
      const age = t - stateEnter;
      const k = Math.sin(Math.min(1, age / 440) * Math.PI);
      pose.lift = k * 15;
      pose.sx = 1 - 0.12 * k; pose.sy = 1 + 0.14 * k;
      pose.mouth = (age > 110 && age < 360) ? 1 : 0.25;
      pose.tongue = 0.25; pose.ear = -0.6; pose.headDx = 3; pose.headDy = -2;
    }
    // shake-off: a fast body wiggle with ears flapping
    if (S.state === 'shake') {
      const w = Math.sin(t / 38);
      pose.sx = 1 + 0.12 * Math.abs(w); pose.sy = 1 - 0.08 * Math.abs(w);
      pose.headDx = w * 1.5; pose.ear = w; pose.tail = Math.sin(t / 50) * 0.8;
    }
    // spin: a little tail-chase bounce (the main process flips his facing)
    if (S.state === 'spin') { pose.bob = -Math.abs(Math.sin(t / 80)) * 1.2; pose.tail = Math.sin(t / 70); }

    // gaze: eyes/head follow the cursor (in window-local space)
    applyGaze(pose);

    // "notices you": when the cursor is near/over him, perk the ears and look
    const near = cursor.near || 0;
    if (near > 0.05 && (S.state === 'idle' || S.state === 'sit' || S.state === 'walk' || S.state === 'pet')) {
      pose.ear = Math.min(pose.ear, -0.2 * near);     // ears perk up toward the cursor
      pose.headTilt = (pose.headTilt || 0) + 0.12 * near;
    }

    // sniffing: head dips and bobs at the ground
    if (A.headUp < -0.2) { pose.headDy = 4 * -A.headUp + Math.sin(t / 160) * 1; pose.headTilt = -0.1; }
    // looking up at a cursor that's above
    if (A.headUp > 0.2) { pose.headTilt = 0.4 * A.headUp; pose.headDy = -2 * A.headUp; }

    // thinking wobble + dots
    if (A.think > 0.3) { pose.headTilt = 0.4 + Math.sin(t / 380) * 0.12; pose.ear = -0.35; }

    // overlays
    pose.heart = A.heart > 0.05 ? A.heart : 0;
    if (S.state === 'nap' || S.state === 'sleep') { pose.zzz = 0.9; pose.blink = 1; }
    if (S.state === 'pet' && Math.random() < 0.02) pose.sparkle = 1;

    // blink (not while sleeping which is already closed)
    if (blinking > 0 && S.state !== 'nap' && S.state !== 'sleep') pose.blink = 1;

    // SUPERMAN flying while held + PANIC on grab (the scared-but-soaring gag)
    if (S.state === 'drag') {
      const spd = Math.hypot(cursor.dvx || 0, cursor.dvy || 0);
      const streak = Math.min(1, spd / 1300);
      pose.headDy = -2;                                   // chin up, heroic
      pose.sx = 1 + 0.22 * streak; pose.sy = 1 - 0.1 * streak;
      if (streak < 0.18) pose.bob = Math.sin(t / 420) * 1.8;   // gentle hover when still
      const panicAge = t - stateEnter;
      const panic = Math.max(Math.max(0, 1 - panicAge / 1100), 0.22 * (1 - streak));
      if (panic > 0.05) {
        pose.panic = panic;                              // rig: bulging eyes + "!"
        pose.mouth = Math.max(pose.mouth, 0.55); pose.tongue = 0.35; pose.blink = 0;
        pose.eyeDx = Math.sin(t / 50) * 1.6 * panic; pose.eyeDy = -1;
        if (panic > 0.5) pose.headDx = Math.sign(Math.sin(t / 90)) * 2;   // frantic head turns
      }
    }

    // thrown / falling: a flailing, wide-eyed tumble (cape streams via channels)
    const airborne = cursor.airborne || S.state === 'fall';
    if (airborne) {
      pose.step = 1.7;
      pose.legPhase = (t / 70) % 1;          // legs paddling fast
      pose.dangle = 0; pose.sit = 0; pose.lift = 0; pose.bob = 0; pose.fly = 0;
      pose.ear = Math.sin(t / 42) * 1.1;     // ears flapping
      pose.mouth = 0.8; pose.tongue = 0.65; pose.blink = 0;
      pose.eyeDx = Math.sin(t / 55) * 1.6; pose.eyeDy = -1;   // wide darting eyes
      pose.tail = Math.sin(t / 50); pose.headDy = -1;
      const stretch = Math.min(0.22, (cursor.vmag || 0) / 9000);
      pose.sy = 1 + stretch; pose.sx = 1 - stretch * 0.7;
    }

    // ground shadow (skip while held/airborne; scale with squash)
    if (S.state !== 'drag' && !airborne) {
      const sw = (pose.sx || 1) * (1 - (pose.lift || 0) / 26);
      window.Rio._helpers.ell(bctx, BX - 2, BASE + 3, 13 * sw, 3 * sw, 'rgba(20,15,20,0.24)');
    }

    window.Rio.draw(bctx, BX, BASE, pose, t);
    ctx.imageSmoothingEnabled = false;
    // rotation: tumble while thrown, bank with vertical drag while flying
    let rot = 0;
    if (airborne) rot = cursor.angle || 0;
    else if (S.state === 'drag') rot = Math.max(-0.45, Math.min(0.45, (cursor.dvy || 0) / 700)) * (pose.facing >= 0 ? 1 : -1);
    if (Math.abs(rot) > 0.001) {
      const pivX = canvas.width / 2, pivY = offY + (BASE - 14) * drawScale;  // pivot about his body
      ctx.save();
      ctx.translate(pivX, pivY); ctx.rotate(rot); ctx.translate(-pivX, -pivY);
      ctx.drawImage(buf, 0, 0, BUF_W, BUF_H, offX, offY, BUF_W * drawScale, BUF_H * drawScale);
      ctx.restore();
    } else {
      ctx.drawImage(buf, 0, 0, BUF_W, BUF_H, offX, offY, BUF_W * drawScale, BUF_H * drawScale);
    }

    // dust puff kicked up on landing
    if (landSpring > 0) drawDust(landSpring / 420);
  }

  // dust kicked up where Rio lands; p goes 1 -> 0 over the landing.
  function drawDust(p) {
    const feetX = canvas.width / 2;
    const feetY = offY + BASE * drawScale;
    const grow = 1 - p;
    ctx.save();
    ctx.globalAlpha = Math.max(0, p * 0.5);
    ctx.fillStyle = '#d8cdba';
    const puffs = [[-1, 0, 1], [1, -0.15, 0.85], [-0.5, -0.5, 0.6], [0.6, -0.55, 0.7]];
    for (const [dx, dy, s] of puffs) {
      const r = (3 + grow * 9) * s * drawScale * 0.5;
      const px = feetX + dx * (6 + grow * 16) * drawScale * 0.5;
      const py = feetY + dy * (4 + grow * 6) * drawScale * 0.5 - grow * 2 * drawScale;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function applyGaze(pose) {
    // turn the eyes a little toward the cursor (window-local coords)
    const f = pose.facing;
    const headY = (MARGIN_TOP + BASE - 30) * SCALE;   // roughly where his eyes are
    const ex = Math.max(-1, Math.min(1, (cursor.cx - Wc / 2) / 120));
    const ey = Math.max(-1, Math.min(1, (cursor.cy - headY) / 120));
    if (S.state === 'idle' || S.state === 'sit' || S.state === 'walk' || S.state === 'pet') {
      pose.eyeDx = ex * 1.4 * f; pose.eyeDy = ey * 1.2;
    }
  }

  // ---- pointer interaction (only fires when main has made us interactive) --
  // A press becomes a DRAG only after moving >4px or holding >120ms — so a plain
  // click pets/pokes him instead of yanking him off the floor.
  let down = false, dragging = false, downX = 0, downY = 0, downT = 0, lastPet = 0;
  const headRegion = () => {
    const cssOffX = Wc / 2 - BX * SCALE, cssOffY = MARGIN_TOP * SCALE;
    const hx = cssOffX + (S.facing >= 0 ? 52 : 22) * SCALE;   // head is toward the facing side
    const hy = cssOffY + 18 * SCALE;
    return { x: hx, y: hy, r: 13 * SCALE };
  };
  function overHead(x, y) { const h = headRegion(); return Math.hypot(x - h.x, y - h.y) < h.r; }

  window.addEventListener('mousemove', (e) => {
    if (down) {
      if (!dragging && (Math.hypot(e.clientX - downX, e.clientY - downY) > 4 || performance.now() - downT > 120)) {
        dragging = true; window.rio.dragStart();
      }
      return;
    }
    if (overHead(e.clientX, e.clientY)) {     // petting: cursor over the head
      const now = performance.now();
      if (now - lastPet > 110) { lastPet = now; resumeAudio(); window.rio.action('pet'); }
    }
  });
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    down = true; dragging = false; downX = e.clientX; downY = e.clientY; downT = performance.now();
    resumeAudio();
  });
  let pokeTimer = null;
  window.addEventListener('mouseup', () => {
    if (!down) return; down = false;
    if (dragging) { dragging = false; window.rio.dragEnd(); }
    else { clearTimeout(pokeTimer); pokeTimer = setTimeout(() => window.rio.action('poke', { fromLeft: true }), 240); }  // defer; cancel on dblclick
  });
  window.addEventListener('dblclick', () => { clearTimeout(pokeTimer); resumeAudio(); window.rio.action('doubleclick'); });
  const release = () => { if (down) { down = false; if (dragging) { dragging = false; window.rio.dragEnd(); } } };
  window.addEventListener('blur', release);
  window.addEventListener('mouseleave', release);
  document.addEventListener('pointercancel', release);

  // ---- speech bubble -------------------------------------------------------
  let bubbleHideTimer = null;
  function setBubble(text) {
    if (text) {
      bubbleEl.textContent = text;
      bubbleEl.classList.add('show');
      clearTimeout(bubbleHideTimer);
      bubbleHideTimer = setTimeout(() => bubbleEl.classList.remove('show'), 5000); // safety net
    } else {
      clearTimeout(bubbleHideTimer);
      bubbleEl.classList.remove('show');
    }
  }

  // ---- synthesized dog sounds (WebAudio, no asset files) -------------------
  let actx = null, muted = false, cfgCape = true;
  function resumeAudio() { if (actx && actx.state === 'suspended') actx.resume(); }
  function ensureAudio() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } return actx; }
  function sound(kind) {
    if (muted) return; const ac = ensureAudio(); if (!ac) return; resumeAudio();
    const now = ac.currentTime;
    if (kind === 'bark' || kind === 'yip') {
      const o = ac.createOscillator(), g = ac.createGain(), f = ac.createBiquadFilter();
      o.type = 'sawtooth'; f.type = 'bandpass';
      const base = kind === 'bark' ? 360 : 620;
      f.frequency.value = base * 1.6; f.Q.value = 1.2;
      o.frequency.setValueAtTime(base, now);
      o.frequency.exponentialRampToValueAtTime(base * 0.55, now + 0.10);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(kind === 'bark' ? 0.22 : 0.14, now + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'bark' ? 0.16 : 0.11));
      o.connect(f); f.connect(g); g.connect(ac.destination);
      o.start(now); o.stop(now + 0.2);
    }
  }

  // ---- wire up IPC ---------------------------------------------------------
  window.rio.onTick((tk) => {
    cursor = tk;
    // main is authoritative: if it says the drag ended but our mouseup never
    // arrived (the window flipped click-through), clear the stuck latch.
    if (dragging && !tk.dragging) { dragging = false; down = false; }
    if (down && !tk.dragging && performance.now() - downT > 6000) { down = false; dragging = false; }  // watchdog
  });
  window.rio.onState((st) => {
    S = Object.assign(S, st);
    setBubble(st.bubble || '');
  });
  window.rio.onConfig((cfg) => { muted = !!cfg.mute; if (cfg.cape !== undefined) cfgCape = !!cfg.cape; if (cfg.name) S.name = cfg.name; fit(); });
  window.rio.onCommand((c) => { if (c && c.bubble != null) setBubble(c.bubble); });

  window.addEventListener('resize', fit);
  fit();
  window.rio.ready();
  window.rio.getConfig().then((cfg) => { if (cfg) { muted = !!cfg.mute; if (cfg.cape !== undefined) cfgCape = !!cfg.cape; S.name = cfg.name || S.name; fit(); } });
  requestAnimationFrame(frame);
})();
