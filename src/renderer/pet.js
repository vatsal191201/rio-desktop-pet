/*
 * pet.js — Rio's body. The main process decides WHICH behaviour Rio is in;
 * this renderer turns that behaviour (plus the live cursor) into smoothly
 * animated pixels via the Rio rig, handles direct pointer interaction when the
 * window is interactive, draws the speech bubble, and makes dog noises.
 */
(function () {
  'use strict';

  const BUF_W = 72, BUF_H = 60, BX = 37, BASE = 50, GROUND_PAD = 6;

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
    Wc = window.innerWidth; Hc = window.innerHeight;
    SCALE = Wc / BUF_W;            // may be fractional (e.g. 1.5); stays crisp on Retina
    drawScale = SCALE * dpr;
    canvas.width = Math.round(Wc * dpr);
    canvas.height = Math.round(Hc * dpr);
    canvas.style.width = Wc + 'px';
    canvas.style.height = Hc + 'px';
    offX = Math.round(canvas.width / 2 - BX * drawScale);
    offY = Math.round((Hc - GROUND_PAD) * dpr - BASE * drawScale);
    ctx.imageSmoothingEnabled = false;
    reportHitbox();
  }

  // Rio's interactive box in window CSS px (a bit generous), reported to main
  // so it can decide when to disable click-through.
  function reportHitbox() {
    const cssOffX = Wc / 2 - BX * SCALE;
    const cssOffY = (Hc - GROUND_PAD) - BASE * SCALE;
    const x = cssOffX + 11 * SCALE, w = 44 * SCALE;
    const y = cssOffY + 6 * SCALE, h = 48 * SCALE;
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
      case 'drag': T.dangle = 1; T.ear = 1; T.tongue = 0.7; T.mouth = 0.25; break;
      case 'land': T.ear = 0.5; T.mouth = 0.2; break;
      case 'idle': default: T.ear = 0.35; break;
    }
    return T;
  }

  // ---- timers & procedural motion -----------------------------------------
  let t = 0, blinkTimer = 1500 + Math.random() * 2500, blinking = 0;
  let legPhase = 0, lastState = '', stateEnter = 0, landSpring = 0, pawWave = 0;

  function frame(ts) {
    const now = ts || 0;
    const dt = Math.min(50, frame._last ? now - frame._last : 16);
    frame._last = now; t += dt;

    if (S.state !== lastState) { onEnterState(S.state); lastState = S.state; stateEnter = t; }

    // ease channels toward targets
    const T = targetsFor(S.state);
    const k = 1 - Math.pow(0.001, dt / 1000);   // ~ time-based smoothing
    for (const key of ['sit', 'lie', 'curl', 'roll', 'paw', 'scratch', 'ear', 'headUp', 'lift', 'dangle',
      'think', 'run', 'stretch', 'playbow', 'beg', 'dig', 'overheat']) {
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
    requestAnimationFrame(frame);
  }

  function onEnterState(st) {
    if (st === 'bark') { sound('bark'); }
    if (st === 'land') { landSpring = 360; }
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

    // breathing / idle life
    const breathing = (S.state === 'idle' || S.state === 'sit') ? Math.sin(t / 620) * 0.6 : 0;
    pose.bob = breathing;

    // walk / run leg cycle, driven by how fast Rio is actually travelling
    const moving = (S.state === 'walk' || S.state === 'come' || S.state === 'chase' || S.state === 'celebrate');
    if (moving) {
      const runF = A.run;
      legPhase += (dtSpeed() * (runF > 0.5 ? 0.0019 : 0.0013));
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

    // landing squash
    if (landSpring > 0) {
      const k = landSpring / 360;
      pose.sx = 1 + 0.18 * k; pose.sy = 1 - 0.18 * k;
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

    // dragged "mochi" wobble
    if (S.state === 'drag') {
      pose.sy = 1.06 + Math.sin(t / 110) * 0.05;
      pose.sx = 1 / pose.sy;
      pose.tail = Math.sin(t / 130) * 0.6;
    }

    // ground shadow (skip while dragged/rolled, scale with squash)
    if (S.state !== 'drag') {
      const sw = (pose.sx || 1) * (1 - (pose.lift || 0) / 26);
      window.Rio._helpers.ell(bctx, BX - 2, BASE + 3, 13 * sw, 3 * sw, 'rgba(20,15,20,0.24)');
    }

    window.Rio.draw(bctx, BX, BASE, pose, t);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, BUF_W, BUF_H, offX, offY, BUF_W * drawScale, BUF_H * drawScale);
  }

  // approximate travel speed for leg cadence (px/frame proxy)
  let _lastCx = 0;
  function dtSpeed() { return 1; }

  function applyGaze(pose) {
    // cursor relative to Rio's head, in buffer space-ish; turn eyes & a little head
    const f = pose.facing;
    const headScreenX = offX / drawScale + BX; // not exact; use cursor sign instead
    const dx = cursor.cx - Wc / 2;
    const dy = cursor.cy - (Hc - GROUND_PAD - BASE * 0 - 30); // head is up high
    const ex = Math.max(-1, Math.min(1, dx / 120));
    const ey = Math.max(-1, Math.min(1, (cursor.cy - (Hc * 0.35)) / 120));
    if (S.state === 'idle' || S.state === 'sit' || S.state === 'walk' || S.state === 'pet') {
      pose.eyeDx = ex * 1.4 * f; pose.eyeDy = ey * 1.2;
    }
  }

  // ---- pointer interaction (only fires when main has made us interactive) --
  let down = false, downX = 0, downY = 0, moved = false, lastPet = 0;
  const headRegion = () => {
    // head is toward the facing side, upper area
    const cssOffX = Wc / 2 - BX * SCALE, cssOffY = (Hc - GROUND_PAD) - BASE * SCALE;
    const hx = cssOffX + (S.facing >= 0 ? 44 : 8) * SCALE;
    const hy = cssOffY + 16 * SCALE;
    return { x: hx, y: hy, r: 12 * SCALE };
  };
  function overHead(x, y) { const h = headRegion(); return Math.hypot(x - h.x, y - h.y) < h.r; }

  window.addEventListener('mousemove', (e) => {
    if (down) { if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true; return; }
    // petting: cursor sweeping over the head
    if (overHead(e.clientX, e.clientY)) {
      const now = performance.now();
      if (now - lastPet > 110) { lastPet = now; resumeAudio(); window.rio.action('pet'); }
    }
  });
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    down = true; moved = false; downX = e.clientX; downY = e.clientY;
    resumeAudio();
    window.rio.dragStart();
  });
  window.addEventListener('mouseup', () => {
    if (!down) return; down = false;
    window.rio.dragEnd();
    if (!moved) window.rio.action('poke', { fromLeft: true });
  });
  window.addEventListener('dblclick', () => { resumeAudio(); window.rio.action('doubleclick'); });
  window.addEventListener('blur', () => { if (down) { down = false; window.rio.dragEnd(); } });

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
  let actx = null, muted = false;
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
  window.rio.onTick((tk) => { cursor = tk; });
  window.rio.onState((st) => {
    S = Object.assign(S, st);
    setBubble(st.bubble || '');
  });
  window.rio.onConfig((cfg) => { muted = !!cfg.mute; if (cfg.name) S.name = cfg.name; fit(); });
  window.rio.onCommand((c) => { if (c && c.bubble != null) setBubble(c.bubble); });

  window.addEventListener('resize', fit);
  fit();
  window.rio.ready();
  window.rio.getConfig().then((cfg) => { if (cfg) { muted = !!cfg.mute; S.name = cfg.name || S.name; fit(); } });
  requestAnimationFrame(frame);
})();
