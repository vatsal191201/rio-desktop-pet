/*
 * rio.js — procedural pixel-art rig for Rio, a black-and-tan desktop dog.
 *
 * Rio is drawn into a small low-resolution buffer (logical pixels) and then
 * scaled up with nearest-neighbour sampling so it reads as crisp pixel art.
 * Every visible part (body, head, ears, four legs, tail, collar, face) is a
 * parametric shape so all animation states are driven by a single `pose`
 * object instead of dozens of hand-drawn frames. This keeps Rio consistent,
 * smooth, and tweakable.
 *
 * Coordinate space: the rig draws relative to an anchor (cx, baseline) where
 * `baseline` is the y of Rio's paws on the floor and `cx` is his horizontal
 * centre. Positive local dx points toward Rio's FACE; `facing` mirrors him.
 */
(function (global) {
  'use strict';

  // ---- Palette -------------------------------------------------------------
  // A tight black-and-tan palette. The black coat is a soft cool near-black
  // (never pure #000) and the tan ranges fawn->caramel, matching real Rio.
  const PAL = {
    OUT:  '#241a1e', // silhouette outline (warm near-black, not pure black)
    K:    '#3a2f33', // black coat (saddle / head top / ears / tail)
    KS:   '#2b2227', // black coat shadow
    KH:   '#4d4248', // black coat top highlight (subtle rim light)
    T:    '#86501f', // tan mid — DARK brown is Rio's dominant second colour
    TL:   '#a86c2e', // tan light — used sparingly for highlights/eyebrow dots
    TD:   '#5e3717', // tan dark/shadow (shading, leg creases, paw underside)
    TF:   '#472a12', // tan far-side (legs/parts behind the body)
    MUZ:  '#b07636', // muzzle tan (a touch warmer so the face still reads)
    NOSE: '#1c1518', // nose
    NH:   '#4b4350', // nose shine
    EYE:  '#15100f', // eye
    EYEW: '#fbf3e3', // eye shine
    BROW: '#b1742f', // tan eyebrow dot (pops on the black forehead)
    TONG: '#e0728a', // tongue
    TONGD:'#bf5470', // tongue shadow / centre crease
    PAW:  '#9c5a55', // paw pads + inner-ear flesh (dusty mauve)
    COL:  '#d6473b', // collar red
    COLS: '#a8322a', // collar red shadow
    TAG:  '#f2c24e', // collar tag gold
    TAGS: '#c9962f', // tag shadow
    BELLY:'#90581f', // belly tan — kept dark so light brown stays minimal
    CAPE: '#e2362f', // superhero cape (brighter than the collar)
    CAPED:'#a31d18', // cape fold / shadow
    CAPEH:'#f26a5f', // cape highlight ridge
    GLASS:'#23202a', // reading-glasses frame
    LENS: '#bfe6f4', // glasses lens glint
    BOOKC:'#3f6fb0', // book cover (blue)
    BOOKP:'#f4ede0', // book pages (cream)
    BOOKE:'#c7b9a0', // book page edges
  };

  // ---- Low-level raster helpers -------------------------------------------
  // All primitives snap to integer pixels so the output stays truly pixelated.
  function px(ctx, x, y, c) {
    x = Math.round(x); y = Math.round(y);
    ctx.fillStyle = c;
    ctx.fillRect(x, y, 1, 1);
  }
  function fr(ctx, x, y, w, h, c) {
    x = Math.round(x); y = Math.round(y);
    ctx.fillStyle = c;
    ctx.fillRect(x, y, Math.round(w), Math.round(h));
  }
  // Filled, pixel-rasterised ellipse centred on (cx,cy).
  function ell(ctx, cx, cy, rx, ry, c) {
    ctx.fillStyle = c;
    const x0 = Math.ceil(-rx), x1 = Math.floor(rx);
    const y0 = Math.ceil(-ry), y1 = Math.floor(ry);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x * x) / (rx * rx) + (y * y) / (ry * ry) <= 1.0) {
          ctx.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1);
        }
      }
    }
  }
  // A thick capsule stroke from (x0,y0) to (x1,y1), radius r — used for legs,
  // ears and the tail.
  // A flowing superhero cape: a chain from the shoulder anchor that blends from
  // gravity (hangs) toward the flow direction (streams) with a perpendicular
  // billow that grows toward the free end. Rendered as a tapering ribbon.
  function drawCape(ctx, ax, ay, fx, fy, stream, billow, t, amt) {
    amt = amt === undefined ? 1 : amt;        // 0 = furled away, 1 = full cape
    const N = 7, seg = 4.6 * amt;
    // rest direction trails BACK and down (fx is already facing-adjusted, points behind)
    const bx = fx, by = 0.55;                      // resting drape: backward + down
    let dx = bx * (1 - stream) + fx * stream;
    let dy = by * (1 - stream) + fy * stream;
    const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const perpx = -dy, perpy = dx;
    const pts = [];
    let x = ax, y = ay;
    for (let i = 0; i <= N; i++) {
      const tt = i / N;
      const amp = (0.8 + tt * tt * 4.6) * (0.4 + billow * 1.8);
      const wave = Math.sin(t / 100 + i * 0.95) * amp;
      const droop = (1 - stream) * tt * tt * 4.0;       // the free end sags under gravity
      pts.push({ x: x + perpx * wave, y: y + perpy * wave + droop, w: (9.5 - tt * 6.5) * amt });
      x += dx * seg; y += dy * seg;
    }
    for (let i = 0; i < N; i++) { const a = pts[i], b = pts[i + 1]; cap(ctx, a.x, a.y + 1, b.x, b.y + 1, Math.max(1.5, a.w / 2), PAL.CAPED); } // fold shadow
    for (let i = 0; i < N; i++) { const a = pts[i], b = pts[i + 1]; cap(ctx, a.x, a.y, b.x, b.y, Math.max(1, a.w / 2 - 0.7), PAL.CAPE); }     // cape face
    for (let i = 1; i < N; i++) { const a = pts[i]; px(ctx, a.x, a.y, PAL.CAPED); }                                                           // centre crease
    for (let i = 0; i < 4; i++) { const a = pts[i]; px(ctx, a.x + perpx * (a.w / 2 - 1), a.y + perpy * (a.w / 2 - 1), PAL.CAPEH); }           // ridge highlight
    ell(ctx, ax, ay, 2.6, 2.2, PAL.CAPE);                                                                                                     // shoulder clasp
    ell(ctx, ax, ay, 1.2, 1.2, PAL.TAG);
  }

  function cap(ctx, x0, y0, x1, y1, r, c) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.max(1, Math.hypot(dx, dy));
    const steps = Math.ceil(len) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ell(ctx, x0 + dx * t, y0 + dy * t, r, r, c);
    }
  }

  // ---- Pose construction ---------------------------------------------------
  // A pose is a plain object of channels; `defaultPose()` is the neutral
  // standing pet. Behaviour code mutates a shallow copy of this.
  function defaultPose() {
    return {
      facing: 1,      // 1 = facing right, -1 = facing left
      bob: 0,         // whole-body vertical bob (px, + = down)
      sx: 1, sy: 1,   // body squash/stretch
      lift: 0,        // whole-body lift off the floor (jump / being picked up)
      dangle: 0,      // 0..1 legs hang straight down (being held / dragged)
      tilt: 0,        // whole-body rotation (radians) for dangling when dragged
      legPhase: 0,    // 0..1 gait phase
      legSpread: 0,   // legs splayed (sit/sleep tuck when negative)
      step: 0,        // stride amount (0 = standing, 1 = full walk)
      tail: 0,        // tail wag, -1..1 (also a base curl)
      tailWagSpeed: 0,
      headDx: 0, headDy: 0, // head offset (look around / sniff down)
      headTilt: 0,    // head tilt (curiosity)
      ear: 0,         // ear flop: -1 perked up .. 1 floppy down/back
      mouth: 0,       // 0 closed .. 1 open (bark / pant)
      tongue: 0,      // 0 in .. 1 out (pant / lick)
      blink: 0,       // 0 open .. 1 closed
      eyeDx: 0, eyeDy: 0, // pupil look direction
      heart: 0,       // 0..1 love hearts above head
      zzz: 0,         // 0..1 sleeping Zzz
      sparkle: 0,     // 0..1 happy sparkle
      sit: 0,         // 0..1 sitting (haunches down, back legs folded)
      lie: 0,         // 0..1 lying down (stretched out)
      curl: 0,        // 0..1 curled-up nap (ball, nose to tail)
      rollOver: 0,    // 0..1 rolled onto back, paws in the air
      stretch: 0,     // 0..1 downward-dog stretch (front low, rear up)
      playbow: 0,     // 0..1 play bow (front down, rear up, wagging — "let's play!")
      beg: 0,         // 0..1 sit pretty / beg (both front paws up)
      dig: 0,         // 0..1 digging at the ground
      digPhase: 0,    // rapid dig oscillation
      pawUp: 0,       // 0..1 lift the near front paw ("give paw" / wave)
      scratch: 0,     // 0..1 sitting & scratching ear with a back leg
      scratchPhase: 0,// rapid scratch oscillation
      overheat: 0,    // 0..1 hot & bothered — sweat drops + steam
      excite: 0,      // 0..1 little excited hop bounce
      cape: true,     // wears a little superhero cape
      capeFx: -1,     // cape flow direction x, LOCAL (-1 = trails behind him)
      capeFy: 0.4,    // cape flow direction y (some downward droop)
      capeStream: 0.5, // 0 = hangs straight down, 1 = streams dramatically
      capeAmt: 1,      // 0 = furled/hidden, 1 = full (the app retracts it on landing)
      fly: 0,         // 0..1 superman flying pose (front paws forward, legs trailing)
      panic: 0,       // 0..1 panicky flailing (wide eyes, sweat, "!")
      glasses: 0,     // 0..1 reading glasses on
      book: 0,        // 0..1 holding an open book
      bookFlip: 0,    // page-flip phase
      collar: true,
    };
  }

  // ---- The rig -------------------------------------------------------------
  // Draw Rio into `ctx`. (cx, baseline) is the anchor in buffer pixels.
  // `pose` is built by behaviour code. `t` is a time in ms for tiny idle life.
  function draw(ctx, cx, baseline, pose, t) {
    pose = pose || defaultPose();
    t = t || 0;
    const f = pose.facing >= 0 ? 1 : -1;
    // local-x -> buffer-x, with facing mirror around cx
    const X = (dx) => cx + f * dx;

    // Special full-body poses get their own silhouette.
    if ((pose.rollOver || 0) > 0.5) { drawRollOver(ctx, cx, baseline, pose, t, f, X); return; }
    if ((pose.curl || 0) > 0.5)     { drawCurl(ctx, cx, baseline, pose, t, f, X); return; }
    if ((pose.stretch || 0) > 0.5)  { drawStretch(ctx, cx, baseline, pose, t, f, X); return; }
    if ((pose.playbow || 0) > 0.5)  { drawPlaybow(ctx, cx, baseline, pose, t, f, X); return; }

    // Body anchor. `sit`/`lie` lower the rear and the whole stance.
    const sit = pose.sit || 0;
    const lie = pose.lie || 0;
    const groundLift = pose.lift || 0;
    const baseY = baseline - groundLift;

    // Body centre height above the feet.
    let bodyH = 17 - sit * 2 - lie * 7;            // body sits lower when resting
    const bodyCY = baseY - bodyH + (pose.bob || 0);
    const bodyCX = X(-2);

    // Squash/stretch
    const sx = pose.sx || 1, sy = pose.sy || 1;
    const RBX = 15 * sx, RBY = (8.5 + lie * 1.5) * sy;

    // ---------------------------------------------------------------------
    // 0) CAPE — drawn behind everything, streaming from the shoulder.
    // ---------------------------------------------------------------------
    const capeAmt = pose.capeAmt === undefined ? 1 : pose.capeAmt;
    if (pose.cape && capeAmt > 0.03 && lie < 0.5 && (pose.curl || 0) < 0.5) {
      drawCape(ctx, X(8), bodyCY - RBY + 1, (pose.capeFx || 0) * f, (pose.capeFy || 1),
        pose.capeStream || 0, (pose.capeStream || 0) * 0.85 + 0.12, t, capeAmt);
    }

    // ---------------------------------------------------------------------
    // 1) FAR-SIDE LEGS (drawn first, darker, slightly inset so they read as
    //    being behind the torso).
    // ---------------------------------------------------------------------
    const gait = (pose.step || 0);
    const hang = pose.dangle || 0;          // legs hang straight down when held
    const fly = pose.fly || 0;              // superman pose: front paws forward, back legs trailing
    const ph = (pose.legPhase || 0) * Math.PI * 2;
    // leg swing helpers: returns {fx, fy} foot offset for a given phase
    function swing(phase, amp) {
      const s = Math.sin(phase);
      return { fx: s * amp * gait * (1 - hang), fy: -Math.max(0, s) * 3 * gait * (1 - hang) };
    }

    const footY = baseY + hang * 8;         // feet drop below the body when dangling
    const legR = 2.4;
    // hip x positions (local): front pair forward, back pair behind
    const HIP_FB = 9,  HIP_BB = -10; // far back
    const HIP_FN = 7,  HIP_BN = -8;  // near front/back

    if (lie < 0.5) {
      // far back leg (folds flat under the body when sitting)
      if (fly > 0.5) {
        cap(ctx, X(HIP_BB), bodyCY + 2, X(-18), bodyCY - 1, legR, PAL.TF);   // trails back
        ell(ctx, X(-18), bodyCY - 1, 2.4, 1.7, PAL.TD);
      } else if (sit > 0.3) {
        cap(ctx, X(-11), bodyCY + 5 + sit * 5, X(-2), baseY, legR, PAL.TF);
        ell(ctx, X(-2), baseY, 2.8, 1.8, PAL.TD);
      } else {
        const sb = swing(ph + Math.PI, 3.2);
        cap(ctx, X(HIP_BB), bodyCY + 3, X(HIP_BB) + f * sb.fx, footY + sb.fy, legR, PAL.TF);
        ell(ctx, X(HIP_BB) + f * sb.fx, footY + sb.fy, 2.6, 1.8, PAL.TD);
      }
      // far front leg (also begs / digs / flies)
      const beg = pose.beg || 0, dig = pose.dig || 0;
      if (fly > 0.5) {
        cap(ctx, X(HIP_FB), bodyCY + 2, X(18), bodyCY - 3, legR, PAL.TF);    // thrusts forward
        ell(ctx, X(18), bodyCY - 3, 2.4, 1.7, PAL.TD);
      } else if (beg > 0.1) {
        const fx2 = X(HIP_FB + 5), fy2 = bodyCY + 1 - beg * 4;
        cap(ctx, X(HIP_FB), bodyCY + 3, fx2, fy2, legR, PAL.TF);
        ell(ctx, fx2, fy2, 2.4, 1.7, PAL.TD);
      } else if (dig > 0.1) {
        const dv = Math.sin((pose.digPhase || 0) + Math.PI);
        const fx2 = X(HIP_FB + 6 + dv * 1.5), fy2 = footY - Math.max(0, dv) * 4;
        cap(ctx, X(HIP_FB), bodyCY + 3, fx2, fy2, legR, PAL.TF);
        ell(ctx, fx2, fy2, 2.4, 1.7, PAL.TD);
      } else {
        const sf = swing(ph, 3.2);
        cap(ctx, X(HIP_FB), bodyCY + 3, X(HIP_FB) + f * sf.fx, footY + sf.fy, legR, PAL.TF);
        ell(ctx, X(HIP_FB) + f * sf.fx, footY + sf.fy, 2.6, 1.8, PAL.TD);
      }
    }

    // ---------------------------------------------------------------------
    // 2) TAIL (behind body). A curling black tail that wags.
    // ---------------------------------------------------------------------
    {
      const wag = (pose.tail || 0);
      const baseX = X(-14), baseYt = bodyCY - 3;
      // tail curls up and back; wag rotates the tip
      const midX = X(-19), midY = bodyCY - 7 - 1 * Math.abs(wag);
      const tipX = X(-20 + wag * 3), tipY = bodyCY - 13 + wag * 2;
      cap(ctx, baseX, baseYt, midX, midY, 2.6, PAL.K);
      cap(ctx, midX, midY, tipX, tipY, 2.1, PAL.K);
      ell(ctx, tipX, tipY, 2.2, 2.2, PAL.K);
      // a little tan tip
      ell(ctx, tipX, tipY, 1.3, 1.3, PAL.TD);
    }

    // ---------------------------------------------------------------------
    // 3) TORSO. Tan base, black saddle over the top, warm belly + shading.
    // ---------------------------------------------------------------------
    // tan base body
    ell(ctx, bodyCX, bodyCY, RBX, RBY, PAL.T);
    // belly highlight (lower front)
    ell(ctx, X(2), bodyCY + 3, RBX - 4, RBY - 3, PAL.BELLY);
    // chest bulge at the front (lifts up when sitting proud)
    ell(ctx, X(11), bodyCY + 1 - sit * 3, 5.5, 6.5 - lie * 1 + sit * 1.5, PAL.T);
    ell(ctx, X(12), bodyCY + 3 - sit * 3, 4, 4.5, PAL.BELLY);
    // super emblem on the chest (gold shield + tiny bone) — shows with the cape
    if (pose.cape && capeAmt > 0.3) {
      const exx = X(12), eyy = bodyCY + 1 - sit * 3;
      ell(ctx, exx, eyy, 3, 3.6, PAL.OUT);
      ell(ctx, exx, eyy, 2.1, 2.7, PAL.TAG);
      fr(ctx, exx - 1, eyy, 3, 1, PAL.BOOKP);
      px(ctx, exx - 1, eyy - 1, PAL.BOOKP); px(ctx, exx - 1, eyy + 1, PAL.BOOKP);
      px(ctx, exx + 1, eyy - 1, PAL.BOOKP); px(ctx, exx + 1, eyy + 1, PAL.BOOKP);
    }
    // black saddle: an ellipse riding high on the back, smaller so tan shows
    // at chest and belly.
    ell(ctx, X(-3), bodyCY - 3 + lie * 2, RBX - 1, RBY - 1.5, PAL.K);
    // saddle shadow underside
    ell(ctx, X(-3), bodyCY - 1.5 + lie * 2, RBX - 2, RBY - 3, PAL.KS);
    // saddle top rim highlight
    for (let i = -10; i <= 8; i++) {
      px(ctx, X(i - 3), bodyCY - (RBY - 2.2) + Math.abs(i) * 0.18, PAL.KH);
    }
    // hip haunch (black) at the rear — drops to the floor when sitting
    ell(ctx, X(-12), bodyCY + 1 + sit * 6, 6.3 + sit, 6.5 - lie * 1.5 + sit, PAL.K);
    ell(ctx, X(-12), bodyCY + 3 + sit * 6, 4.5, 4.5, PAL.KS);

    // ---------------------------------------------------------------------
    // 4) NEAR-SIDE LEGS (in front of torso, normal tan).
    // ---------------------------------------------------------------------
    function nearLeg(hipx, phase, opts) {
      opts = opts || {};
      let s = swing(phase, 3.4);
      let fx = s.fx, fy = s.fy;
      let hy = bodyCY + 4;
      let footX, footYp;
      if (opts.fold && sit > 0) {
        // back legs fold flat under the body when sitting (haunches down)
        fx = 9 * sit; fy = 0; hy = bodyCY + 5 + sit * 5;
      }
      footX = X(hipx) + f * fx; footYp = footY + fy;
      // the near front leg also does give-paw / beg / dig
      if (opts.paw) {
        const u = pose.pawUp || 0, beg = pose.beg || 0, dig = pose.dig || 0;
        if (beg > 0.1) {            // tucked up to the chest, begging
          footX = X(hipx + 6); footYp = bodyCY + 1 - beg * 5; hy = bodyCY + 3 - sit * 2;
        } else if (dig > 0.1) {     // paddling at the ground
          const dv = Math.sin(pose.digPhase || 0);
          footX = X(hipx + 7 + dv * 1.5); footYp = footY - Math.max(0, dv) * 5; hy = bodyCY + 4;
        } else if (u > 0.02) {      // give paw / wave
          footX = X(hipx + 6 + u * 4); footYp = footY - u * (15 + sit * 3); hy = bodyCY + 3 - sit * 2;
        }
      }
      // scratch: back leg flicks up to the ear and vibrates
      if (opts.scratch && (pose.scratch || 0) > 0.02) {
        const u = pose.scratch;
        const vib = Math.sin(pose.scratchPhase || 0) * 1.4;
        footX = X(hipx + 13 + vib * 0.3);
        footYp = bodyCY - 3 - u * 4 + vib;
        hy = bodyCY + 2;
      }
      // flying superman pose: front paws thrust forward, back legs trail back
      if (fly > 0.5) {
        if (opts.paw) { footX = X(hipx + 14); footYp = bodyCY - 1; hy = bodyCY + 2; }
        else { footX = X(-16); footYp = bodyCY + 1; hy = bodyCY + 3; }
      }
      cap(ctx, X(hipx), hy, footX, footYp, 2.7, PAL.T);
      // knee/shading
      cap(ctx, X(hipx), hy, footX, footYp, 1.3, PAL.TD);
      // paw
      ell(ctx, footX, footYp, 3, 2.1, PAL.T);
      ell(ctx, footX, footYp - 0.5, 2, 1.3, PAL.TL); // paw top light
      fr(ctx, footX - 2, footYp + 1, 4, 1, PAL.TD);  // paw underside
    }
    if (lie < 0.5) {
      nearLeg(HIP_BN, ph + Math.PI + 0.3, { fold: true, scratch: true }); // near back
      nearLeg(HIP_FN, ph + 0.3, { paw: true });                          // near front
    } else {
      // lying: legs stretch out forward along the floor
      cap(ctx, X(6), bodyCY + 4, X(16), baseY + 1, 2.4, PAL.T);
      ell(ctx, X(16), baseY + 1, 3, 2, PAL.TL);
      cap(ctx, X(-6), bodyCY + 4, X(-2), baseY + 1, 2.4, PAL.T);
      ell(ctx, X(-2), baseY + 1, 3, 2, PAL.TL);
    }

    // ---------------------------------------------------------------------
    // 5) NECK + COLLAR + HEAD
    // ---------------------------------------------------------------------
    const headDx = (pose.headDx || 0), headDy = (pose.headDy || 0);
    // when sitting the head rises a touch; when lying it drops to the floor
    const hcx = X(15) + f * headDx;
    const hcy = baseY - 30 - 4 * sit + lie * 9 + (pose.bob || 0) * 0.5 + headDy;

    // neck connecting chest to head (tan)
    cap(ctx, X(11), bodyCY - 2, hcx - f * 4, hcy + 6, 4.5, PAL.T);

    // collar (red band across the neck) with a gold tag
    if (pose.collar) {
      const nckx = X(12) + f * headDx * 0.5;
      const ncky = bodyCY - 4 + (hcy - (bodyCY - 4)) * 0.45;
      cap(ctx, nckx - f * 3, ncky - 4, nckx + f * 3, ncky + 4, 2.3, PAL.COL);
      cap(ctx, nckx - f * 3, ncky - 4 + 1, nckx + f * 3, ncky + 4 + 1, 1.1, PAL.COLS);
      // tag
      ell(ctx, nckx + f * 1, ncky + 5, 1.8, 1.8, PAL.TAG);
      px(ctx, nckx + f * 1, ncky + 6, PAL.TAGS);
    }

    // ---- HEAD ----
    const ht = (pose.headTilt || 0) * f;
    // black skull (top of head)
    ell(ctx, hcx, hcy, 8, 7, PAL.K);
    ell(ctx, hcx - f * 1, hcy - 1, 7, 5.5, PAL.K);
    // tan cheek / jaw
    ell(ctx, hcx + f * 1, hcy + 3, 6.5, 5, PAL.T);
    ell(ctx, hcx + f * 2, hcy + 4, 5, 3.5, PAL.BELLY);
    // muzzle / snout extending toward the face direction
    const mzx = hcx + f * 7, mzy = hcy + 2;
    ell(ctx, mzx, mzy, 5.5, 4, PAL.MUZ);
    ell(ctx, mzx + f * 1, mzy + 1, 4, 3, PAL.TL);
    // snout top bridge (black runs down between the eyes a touch)
    ell(ctx, hcx + f * 3, hcy - 2, 4, 3, PAL.K);

    // nose at the tip
    const nx = mzx + f * 4, ny = mzy - 0.5;
    ell(ctx, nx, ny, 2.4, 2, PAL.NOSE);
    px(ctx, nx - f * 1, ny - 1, PAL.NH);

    // mouth / tongue
    const open = pose.mouth || 0;
    const tongue = pose.tongue || 0;
    if (open > 0.05 || tongue > 0.05) {
      // open mouth: a dark opening at the lower-front of the snout
      ell(ctx, mzx + f * 1.5, mzy + 2.5, 3, 1.4 + open * 1.4, PAL.OUT);
      if (tongue > 0.05) {
        // a lolling tongue that hangs down-forward from the mouth
        const tx = mzx + f * 2, ty = mzy + 3.5 + open * 1.2;
        ell(ctx, tx, ty, 1.8, 1.6 + tongue * 1.6, PAL.TONG);
        ell(ctx, tx + f * 0.5, ty + 1 + tongue, 1.4, 1.1, PAL.TONG);
        fr(ctx, tx, ty - 0.5, 1, 2 + tongue * 1.5, PAL.TONGD); // centre crease
      }
    } else {
      // closed: a gentle upturned smile
      fr(ctx, mzx - f * 1, mzy + 2.5, 4, 1, PAL.TD);
      px(ctx, mzx + f * 3, mzy + 2.5, PAL.OUT);
    }

    // single tan eyebrow dot (the black-and-tan signature) — a clean 2px spot
    const ebx = hcx + f * 2, eby = hcy - 4;
    fr(ctx, ebx - 1, eby - 1, 2, 2, PAL.BROW);

    // eye
    const blink = pose.blink || 0;
    const ex = hcx + f * 2.5, ey = hcy - 0.5;
    const pan = pose.panic || 0;
    if (blink > 0.55) {
      fr(ctx, ex - 2, ey, 3, 1, PAL.OUT); // closed eye line
    } else if (pan > 0.25) {
      // terrified saucer eye: big white, tiny darting pupil
      const er = 2.4 + pan * 1.2;
      ell(ctx, ex, ey, er + 0.6, er + 0.8, PAL.OUT);
      ell(ctx, ex, ey, er, er + 0.3, PAL.EYEW);
      ell(ctx, ex + f * (pose.eyeDx || 0) * 0.8, ey + (pose.eyeDy || 0) * 0.6, 1.0, 1.2, PAL.EYE);
    } else {
      ell(ctx, ex, ey, 2.1, 2.3, PAL.OUT); // eye socket
      ell(ctx, ex + f * (pose.eyeDx || 0) * 0.6, ey + (pose.eyeDy || 0) * 0.6, 1.4, 1.7, PAL.EYE);
      px(ctx, ex + f * 1, ey - 1, PAL.EYEW); // shine
    }
    // reading glasses
    if ((pose.glasses || 0) > 0.3) {
      ell(ctx, ex, ey, 3.2, 3.2, PAL.GLASS);     // near lens frame
      ell(ctx, ex, ey, 2.2, 2.2, PAL.LENS);
      ell(ctx, ex, ey, 1.1, 1.3, PAL.EYE);       // eye through the lens
      px(ctx, ex - f * 1, ey - 1, PAL.EYEW);     // glint
      fr(ctx, ex + f * 3, ey - 1, 2, 1, PAL.GLASS); // bridge
      ell(ctx, ex + f * 6, ey - 0.5, 2.6, 2.6, PAL.GLASS); // far lens
      ell(ctx, ex + f * 6, ey - 0.5, 1.6, 1.6, PAL.LENS);
      cap(ctx, ex - f * 2, ey - 1, ex - f * 6, ey - 2, 0.8, PAL.GLASS); // temple arm to ear
    }

    // ---- NEAR EAR (floppy, in front, hangs by the cheek) ----
    // ear flop: pose.ear -1 perked .. +1 floppy down
    const earFlop = (pose.ear || 0);
    const erx0 = hcx - f * 4, ery0 = hcy - 6;             // ear root (top-back of head)
    const erx1 = hcx - f * (5 - earFlop * 1) + f * (earFlop > 0 ? 1 : 0);
    const ery1 = hcy + 3 + earFlop * 5;                    // ear tip drops when floppy
    cap(ctx, erx0, ery0, erx1, ery1, 3, PAL.K);
    ell(ctx, erx1, ery1, 2.6, 2.8, PAL.K);
    ell(ctx, erx1, ery1, 1.4, 1.6, PAL.KS); // inner-ear shadow (keeps the ear clean)
    // a flesh-pink inner hint only shows when the ear is perked away from the cheek
    if (earFlop < -0.1) ell(ctx, erx1, ery1, 1, 1.2, PAL.PAW);

    // ---------------------------------------------------------------------
    // 6) OVERLAY EFFECTS: hearts, sparkle, Zzz
    // ---------------------------------------------------------------------
    if ((pose.heart || 0) > 0.05) drawHeart(ctx, X(18), hcy - 12 - pose.heart * 4, pose.heart);
    if ((pose.zzz || 0) > 0.05)   drawZzz(ctx, X(20), hcy - 10, t, pose.zzz);
    if ((pose.sparkle || 0) > 0.05) drawSparkle(ctx, X(20), hcy - 9, t, pose.sparkle);
    if ((pose.overheat || 0) > 0.05) drawOverheat(ctx, hcx, hcy, t, pose.overheat, f);
    if ((pose.panic || 0) > 0.4)  { drawBang(ctx, X(19), hcy - 13, t); drawOverheat(ctx, hcx, hcy, t, pose.panic * 0.7, f); }
    if ((pose.book || 0) > 0.3)   drawBook(ctx, X(14), bodyCY + 3, f, t, pose.bookFlip || 0);
  }

  function drawBang(ctx, x, y, t) {
    const pop = (Math.sin(t / 90) + 1) / 2;
    const yy = y - pop * 1.5;
    fr(ctx, x, yy, 1, 3, PAL.CAPE); fr(ctx, x, yy + 4, 1, 1, PAL.CAPE);   // exclamation
    px(ctx, x - 1, yy - 1, '#fff'); px(ctx, x + 1, yy, PAL.CAPED);
  }

  function drawBook(ctx, x, y, f, t, flip) {
    fr(ctx, x - 6, y - 4, 12, 8, PAL.BOOKC);        // cover
    fr(ctx, x - 5, y - 3, 11, 6, PAL.BOOKP);        // pages
    fr(ctx, x - 1, y - 4, 1, 8, PAL.BOOKC);         // spine
    for (let i = 0; i < 2; i++) { fr(ctx, x - 4, y - 2 + i * 2, 3, 1, PAL.BOOKE); fr(ctx, x + 1, y - 2 + i * 2, 3, 1, PAL.BOOKE); }
    if (flip > 0.02) {                              // a page lifting & turning over
      const lift = Math.sin(flip * Math.PI) * 5;
      const tx = x - 1 + (flip - 0.5) * 9;
      cap(ctx, x - 1, y - 3, tx, y - 3 - lift, 0.9, PAL.BOOKP);
      ell(ctx, tx, y - 3 - lift, 1.3, 1.7, PAL.BOOKP);
    }
  }

  function drawOverheat(ctx, hcx, hcy, t, a, f) {
    const drop = '#9fd6ef', steam = '#eef3f6';
    const dy = (t / 240) % 7;
    px(ctx, hcx - f * 4, hcy - 5 + dy, drop); px(ctx, hcx - f * 4, hcy - 4 + dy, drop);
    px(ctx, hcx + f * 1, hcy - 6 + ((dy + 3) % 7), drop);
    for (let i = 0; i < 2; i++) { const yy = hcy - 9 - ((t / 200 + i * 4) % 9); ell(ctx, hcx + f * (1 + i * 5), yy, 1.4, 1.4, steam); }
  }

  // ---- Stretch (downward dog): front low, rear high — Rio's break nudge ----
  function drawStretch(ctx, cx, baseline, pose, t, f) {
    const X = (dx) => cx + f * dx;
    const by = baseline;
    const pulse = Math.sin(t / 480) * 0.6;
    // far back leg + tail (raised rear)
    cap(ctx, X(-11), by - 13, X(-10), by, 2.3, PAL.TF);
    ell(ctx, X(-10), by, 2.6, 1.8, PAL.TD);
    cap(ctx, X(-15), by - 14, X(-19), by - 21 - pulse, 2.3, PAL.K);
    ell(ctx, X(-19), by - 21 - pulse, 2.2, 2.2, PAL.K);
    // body sloping front-low -> rear-high
    ell(ctx, X(-2), by - 9, 13, 6, PAL.T);
    ell(ctx, X(-11), by - 12, 7, 6.5, PAL.T);
    ell(ctx, X(8), by - 4, 6, 4.5, PAL.T);
    ell(ctx, X(5), by - 3, 6, 3, PAL.BELLY);
    ell(ctx, X(-11), by - 14, 6.5, 6, PAL.K);       // rear haunch
    ell(ctx, X(-4), by - 12, 11, 5, PAL.K);          // saddle
    ell(ctx, X(-4), by - 11, 9, 3.5, PAL.KS);
    // near back leg
    cap(ctx, X(-9), by - 12, X(-7), by, 2.6, PAL.T);
    ell(ctx, X(-7), by, 3, 2, PAL.TL);
    // front legs stretched far forward, flat on the floor
    cap(ctx, X(7), by - 3, X(17), by, 2.5, PAL.TF);  // far front
    ell(ctx, X(18), by, 2.8, 1.8, PAL.TD);
    cap(ctx, X(8), by - 3, X(19), by, 2.7, PAL.T);   // near front
    ell(ctx, X(20), by, 3.2, 2, PAL.TL);
    // head dropped low between the front legs
    cap(ctx, X(9), by - 4, X(13), by - 2, 4, PAL.T);
    const hx = X(14), hy = by - 3;
    ell(ctx, hx, hy - 1, 6, 5, PAL.K);               // head top (black)
    ell(ctx, hx + f * 5, hy + 1, 4.5, 3.2, PAL.MUZ); // muzzle forward
    ell(ctx, hx + f * 8, hy + 1, 1.9, 1.5, PAL.NOSE);
    fr(ctx, hx + f * 1, hy, 3, 1, PAL.OUT);          // squinted happy eye
    px(ctx, hx + f * 1, hy - 3, PAL.BROW);
    cap(ctx, hx - f * 3, hy - 4, hx - f * 1, hy + 4, 2.6, PAL.K); // ear forward
    ell(ctx, hx - f * 1, hy + 4, 2.3, 2.5, PAL.K);
    drawSparkle(ctx, hx + f * 6, hy - 6, t, 1);
  }

  // ---- Play bow: front down, rear up, head UP, tail wagging — "let's play!"
  function drawPlaybow(ctx, cx, baseline, pose, t, f) {
    const X = (dx) => cx + f * dx;
    const by = baseline;
    const wag = Math.sin(t / 85);
    cap(ctx, X(-11), by - 15, X(-10), by, 2.3, PAL.TF);
    ell(ctx, X(-10), by, 2.6, 1.8, PAL.TD);
    cap(ctx, X(-14), by - 16, X(-18 + wag * 3), by - 23, 2.3, PAL.K);
    ell(ctx, X(-18 + wag * 3), by - 23, 2.3, 2.3, PAL.K);
    ell(ctx, X(-2), by - 10, 13, 6, PAL.T);
    ell(ctx, X(-11), by - 15, 7, 6.5, PAL.T);
    ell(ctx, X(7), by - 5, 6, 4.5, PAL.T);
    ell(ctx, X(4), by - 4, 6, 3, PAL.BELLY);
    ell(ctx, X(-11), by - 16, 6.5, 6, PAL.K);
    ell(ctx, X(-4), by - 13, 11, 5, PAL.K);
    ell(ctx, X(-4), by - 12, 9, 3.5, PAL.KS);
    cap(ctx, X(-9), by - 14, X(-7), by, 2.6, PAL.T);
    ell(ctx, X(-7), by, 3, 2, PAL.TL);
    // front legs folded forward on the ground (the bow), elbows low
    cap(ctx, X(7), by - 4, X(14), by, 2.5, PAL.TF);
    ell(ctx, X(14), by, 2.8, 1.8, PAL.TD);
    cap(ctx, X(8), by - 4, X(16), by, 2.7, PAL.T);
    ell(ctx, X(16), by, 3.2, 2, PAL.TL);
    ell(ctx, X(10), by - 2, 4, 2.5, PAL.T);
    // neck up to a raised happy head
    cap(ctx, X(9), by - 5, X(15), by - 9, 4.5, PAL.T);
    const hx = X(17), hy = by - 11;
    ell(ctx, hx, hy, 7, 6, PAL.K);
    ell(ctx, hx + f * 6, hy + 2, 5, 3.5, PAL.MUZ);
    ell(ctx, hx + f * 9, hy + 1.5, 2, 1.6, PAL.NOSE);
    ell(ctx, hx + f * 6, hy + 4, 3, 1.8, PAL.OUT);   // grin
    ell(ctx, hx + f * 6, hy + 5, 2, 2, PAL.TONG);    // tongue
    px(ctx, hx + f * 6, hy + 5, PAL.TONGD);
    ell(ctx, hx + f * 2.5, hy - 0.5, 2, 2.2, PAL.OUT); // eye
    ell(ctx, hx + f * 3, hy - 0.5, 1.3, 1.6, PAL.EYE);
    px(ctx, hx + f * 4, hy - 1, PAL.EYEW);
    fr(ctx, hx + f * 1, hy - 4, 2, 2, PAL.BROW);     // brow dot
    cap(ctx, hx - f * 4, hy - 5, hx - f * 5, hy + 2, 2.6, PAL.K); // ear
    ell(ctx, hx - f * 5, hy + 2, 2.4, 2.6, PAL.K);
    if ((pose.heart || 0) > 0.05) drawHeart(ctx, X(21), hy - 10, pose.heart);
  }

  // ---- Roll over: Rio flops onto his back, paws in the air, blissful -------
  function drawRollOver(ctx, cx, baseline, pose, t, f, X) {
    const wig = Math.sin(t / 240) * 1.2;          // happy paw wiggle
    const cy = baseline - 6;
    // back (the saddle) pressed to the floor
    ell(ctx, cx - f * 1, baseline - 4, 16, 4.5, PAL.K);
    ell(ctx, cx - f * 1, baseline - 3, 14, 3, PAL.KS);
    // belly facing up (tan dominant)
    ell(ctx, cx - f * 1, cy - 3, 15, 6, PAL.T);
    ell(ctx, cx, cy - 4, 11, 4, PAL.BELLY);
    ell(ctx, cx, cy - 5, 6, 2.2, PAL.TL);          // sunlit belly highlight
    // four legs sticking up, relaxed & bent
    function upLeg(dx, far, swing) {
      const col = far ? PAL.TF : PAL.T;
      const hipx = cx + f * dx, hipy = cy - 4;
      const kneex = hipx + f * (1.6 + swing * 0.2), kneey = cy - 11;
      const pawx = hipx - f * (1 - swing * 0.3), pawy = cy - 15 - (far ? 0 : 1);
      cap(ctx, hipx, hipy, kneex, kneey, far ? 2 : 2.4, col);
      cap(ctx, kneex, kneey, pawx, pawy, far ? 1.7 : 2.1, col);
      ell(ctx, pawx, pawy, far ? 2 : 2.6, far ? 1.4 : 1.8, far ? PAL.TD : PAL.TL); // paw pad up
      ell(ctx, pawx, pawy + 0.5, 1.2, 0.9, PAL.PAW);
    }
    upLeg(-9, true, -wig);   // far back
    upLeg(8, true, wig);     // far front
    upLeg(-7, false, wig);   // near back
    upLeg(6, false, -wig);   // near front
    // head tipped back on the floor at the front
    const hx = cx + f * 15, hy = baseline - 5;
    ell(ctx, hx, hy - 2, 7, 6, PAL.K);             // skull
    // ear splayed on floor behind head
    ell(ctx, hx - f * 5, baseline - 2, 4, 2.2, PAL.KS);
    // muzzle points up-and-forward (upside-down head)
    ell(ctx, hx + f * 3, hy - 5, 4.5, 3.2, PAL.MUZ);
    ell(ctx, hx + f * 4, hy - 6, 2, 1.6, PAL.NOSE); // nose up high
    // blissed-out closed eyes (happy upward arcs)
    fr(ctx, hx - f * 1, hy - 1, 3, 1, PAL.OUT);
    px(ctx, hx - f * 2, hy - 2, PAL.OUT);
    px(ctx, hx + f * 2, hy - 2, PAL.OUT);
    // lolling tongue out the side of the grin
    ell(ctx, hx + f * 4, hy - 2, 1.8, 2.4, PAL.TONG);
    px(ctx, hx + f * 4, hy - 1, PAL.TONGD);
    // tail flopped out behind
    cap(ctx, cx - f * 14, baseline - 4, cx - f * 19, baseline - 2, 2.2, PAL.K);
    if ((pose.heart || 0) > 0.05) drawHeart(ctx, cx, baseline - 24, pose.heart);
    if ((pose.sparkle || 0) > 0.05) drawSparkle(ctx, cx + f * 6, baseline - 22, t, pose.sparkle);
  }

  // ---- Curl-up nap: Rio coiled in a cosy ball, nose to tail, Zzz ------------
  function drawCurl(ctx, cx, baseline, pose, t, f, X) {
    const breathe = Math.sin(t / 720) * 0.7;
    const cy = baseline - 9 + breathe;
    // tail wrapping around the front first (drawn behind the body)
    cap(ctx, cx - f * 12, cy + 2, cx + f * 6, cy + 8, 2.4, PAL.K);
    cap(ctx, cx + f * 6, cy + 8, cx + f * 12, cy + 4, 2.2, PAL.K);
    ell(ctx, cx + f * 12, cy + 4, 2, 2, PAL.TD);   // tan tail tip near the nose
    // big rounded body — tan base, black saddle draped over the top
    ell(ctx, cx, cy + 1, 15, 10 - breathe * 0.5, PAL.T);
    ell(ctx, cx, cy + 3, 13, 7, PAL.BELLY);
    ell(ctx, cx - f * 1, cy - 2, 15, 8.5, PAL.K);  // saddle
    ell(ctx, cx - f * 1, cy - 0.5, 13, 6.5, PAL.KS);
    for (let i = -11; i <= 9; i++) px(ctx, cx + i - f, cy - 8 + Math.abs(i) * 0.18, PAL.KH);
    // little tucked paws peeking at the front-bottom
    ell(ctx, cx + f * 7, baseline - 2, 2.6, 1.8, PAL.T);
    ell(ctx, cx + f * 10, baseline - 2, 2.6, 1.8, PAL.TL);
    // head curled down at the front, nose tucked toward the tail
    const hx = cx + f * 10, hy = cy + 3;
    ell(ctx, hx, hy, 6.5, 6, PAL.K);               // skull (black top)
    ell(ctx, hx + f * 3, hy + 2, 4.5, 3.5, PAL.MUZ); // muzzle tucked low/inward
    ell(ctx, hx + f * 5, hy + 2.5, 1.8, 1.5, PAL.NOSE);
    // ear draped down over the cheek
    cap(ctx, hx - f * 3, hy - 4, hx - f * 4, hy + 3, 2.6, PAL.K);
    ell(ctx, hx - f * 4, hy + 3, 2.4, 2.6, PAL.K);
    // closed sleepy eye
    fr(ctx, hx, hy, 3, 1, PAL.OUT);
    // eyebrow dot
    px(ctx, hx + f * 1, hy - 2, PAL.BROW);
    if ((pose.zzz || 0) > 0.05) drawZzz(ctx, hx + f * 7, hy - 9, t, pose.zzz);
  }

  function drawHeart(ctx, x, y, a) {
    const c = PAL.COL;
    px(ctx, x - 1, y, c); px(ctx, x + 1, y, c);
    fr(ctx, x - 2, y + 1, 5, 1, c);
    fr(ctx, x - 1, y + 2, 3, 1, c);
    px(ctx, x, y + 3, c);
    px(ctx, x - 1, y, PAL.TONG);
  }
  function drawZzz(ctx, x, y, t, a) {
    const c = '#dfe7f2';
    const bob = Math.sin(t / 380) * 1.2;
    // three rising Z's of increasing size
    const Z = (zx, zy, s) => {
      fr(ctx, zx, zy, s, 1, c);
      fr(ctx, zx, zy + s - 1, s, 1, c);
      for (let i = 0; i < s; i++) px(ctx, zx + (s - 1 - i), zy + i, c);
    };
    Z(x, y + bob, 2);
    Z(x + 3, y - 3 + bob, 3);
    Z(x + 7, y - 7 + bob, 4);
  }
  function drawSparkle(ctx, x, y, t, a) {
    const c = '#fff3c4';
    const tw = (Math.sin(t / 160) + 1) / 2;
    if (tw > 0.3) { px(ctx, x, y, c); px(ctx, x - 2, y, c); px(ctx, x + 2, y, c); px(ctx, x, y - 2, c); px(ctx, x, y + 2, c); }
  }

  const Rio = { PAL, draw, defaultPose, _helpers: { px, fr, ell, cap } };
  if (typeof module !== 'undefined' && module.exports) module.exports = Rio;
  global.Rio = Rio;
})(typeof window !== 'undefined' ? window : globalThis);
