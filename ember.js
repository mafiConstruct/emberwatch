/* EMBERWATCH, night 1 prototype
   Real-time: the fire always decays. Inaction costs.
   Player action: move, gather wood, feed the fire, wave off frost moths.
   No assets; canvas + WebAudio synth only. */
'use strict';
(function () {
  const W = 1280, H = 720;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  // ---- fit canvas to window, letterboxed ----
  function fit() {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    canvas.style.width = (W * s) + 'px';
    canvas.style.height = (H * s) + 'px';
  }
  window.addEventListener('resize', fit); fit();

  // ---- seeded RNG (mulberry32); ?seed=N or EMBER.reseed(n) for reproducible runs ----
  let _rs = (new URLSearchParams(location.search)).get('seed');
  let _rstate = ((_rs ? parseInt(_rs, 10) : (Date.now() % 2147483646)) >>> 0) || 1;
  function rng() {
    _rstate |= 0; _rstate = (_rstate + 0x6D2B79F5) | 0;
    let t = Math.imul(_rstate ^ (_rstate >>> 15), 1 | _rstate);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---- constants ----
  const NIGHT_LEN = 180;          // seconds to dawn
  const FIRE_X = 640, FIRE_Y = 520;
  const GROUND_Y = 560;
  const F_MAX = 100;
  const F_DECAY = 0.95;           // per second
  const FEED_VALUE = 8;
  const CARRY_MAX = 3;
  const KEEPER_SPEED = 270;
  const WOOD_INTERVAL = 3.4, WOOD_CAP = 8;
  const SHOO_RADIUS = 200, SHOO_CD = 1.8, SHOO_FLEE_T = 2.1, SHOO_FLEE_V = 260;
  const MOTH_HIT_DMG = 8;

  // ---- state ----
  const S = {
    mode: 'intro',           // intro | play | won | lost
    t: 0,                    // night elapsed
    F: 62,                   // fire intensity
    keeper: { x: 420, dir: 0, carry: 0, shooCd: 0, wave: 0 },
    woods: [],               // {x, bob}
    moths: [],               // {x, y, vx, vy, flee, ph}
    embers: [], snow: [], puffs: [],
    woodTimer: 2.0, mothTimer: 5.0,
    woodFed: 0, mothsShooed: 0, mothsHit: 0,
    timescale: 1,
    shake: 0,
  };

  const keys = {};
  const stars = [];
  for (let i = 0; i < 90; i++) stars.push({ x: rng() * W, y: rng() * 380, r: rng() * 1.4 + 0.3, tw: rng() * 6.28 });
  for (let i = 0; i < 70; i++) S.snow.push({ x: rng() * W, y: rng() * H, v: 12 + rng() * 18, ph: rng() * 6.28 });

  // ---- audio (all synthesized) ----
  let AC = null, crackleGain = null, windGain = null, muted = false;
  function audioInit() {
    if (AC) return;
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      const master = AC.createGain(); master.gain.value = 0.5; master.connect(AC.destination);
      // wind: looped filtered noise
      const len = 2 * AC.sampleRate;
      const buf = AC.createBuffer(1, len, AC.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
      const wind = AC.createBufferSource(); wind.buffer = buf; wind.loop = true;
      const wf = AC.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 240;
      windGain = AC.createGain(); windGain.gain.value = 0.05;
      wind.connect(wf); wf.connect(windGain); windGain.connect(master); wind.start();
      // crackle bed
      const cr = AC.createBufferSource(); cr.buffer = buf; cr.loop = true; cr.playbackRate.value = 0.7;
      const cf = AC.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 900; cf.Q.value = 0.6;
      crackleGain = AC.createGain(); crackleGain.gain.value = 0;
      cr.connect(cf); cf.connect(crackleGain); crackleGain.connect(master); cr.start();
      AC._master = master;
    } catch (e) { AC = null; }
  }
  function blip(freq0, freq1, dur, vol, type) {
    if (!AC || muted) return;
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq0, AC.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, freq1), AC.currentTime + dur);
    g.gain.setValueAtTime(vol, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + dur);
    o.connect(g); g.connect(AC._master); o.start(); o.stop(AC.currentTime + dur);
  }
  function noiseBurst(dur, vol, freq) {
    if (!AC || muted) return;
    const len = Math.floor(dur * AC.sampleRate);
    const b = AC.createBuffer(1, len, AC.sampleRate);
    const dd = b.getChannelData(0);
    for (let i = 0; i < len; i++) dd[i] = (rng() * 2 - 1) * (1 - i / len);
    const s = AC.createBufferSource(); s.buffer = b;
    const f = AC.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = freq || 1200;
    const g = AC.createGain(); g.gain.value = vol;
    s.connect(f); f.connect(g); g.connect(AC._master); s.start();
  }

  // ---- spawning ----
  function spawnWood() {
    if (S.woods.length >= WOOD_CAP) return;
    const side = rng() < 0.5 ? 0 : 1;
    const x = side === 0 ? 60 + rng() * 500 : 680 + rng() * 540;
    S.woods.push({ x, bob: rng() * 6.28 });
  }
  function spawnMoth() {
    const fromLeft = rng() < 0.5;
    const x = fromLeft ? -20 : W + 20;
    const y = 120 + rng() * 260;
    S.moths.push({ x, y, vx: 0, vy: 0, flee: 0, ph: rng() * 6.28, sp: 30 + rng() * 16 });
  }
  // moths arrive in visible drifts from one side: a well-timed wave clears the drift,
  // a wasted wave leaves the cooldown empty when it arrives.
  function spawnClump(n) {
    const fromLeft = rng() < 0.5;
    const bx = fromLeft ? -20 : W + 20;
    const by = 120 + rng() * 260;
    for (let i = 0; i < n; i++) {
      S.moths.push({
        x: bx + (rng() - 0.5) * 80, y: by + (rng() - 0.5) * 100,
        vx: 0, vy: 0, flee: 0, ph: rng() * 6.28, sp: 30 + rng() * 16,
      });
    }
  }

  // ---- input ----
  const input = { left: false, right: false, shoo: false };
  function keymap(code, down) {
    if (code === 'ArrowLeft' || code === 'KeyA') input.left = down;
    if (code === 'ArrowRight' || code === 'KeyD') input.right = down;
    if (code === 'Space' && down) input.shoo = true;
    if (code === 'KeyM' && down) { muted = !muted; }
    if (code === 'KeyR' && down && (S.mode === 'won' || S.mode === 'lost')) restart();
  }
  window.addEventListener('keydown', (e) => {
    audioInit();
    if (S.mode === 'intro') { S.mode = 'play'; return; }
    keymap(e.code, true);
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keymap(e.code, false));

  // touch: hold left/right half to move, tap fire-side center to wave
  let touchMove = 0;
  canvas.addEventListener('pointerdown', (e) => {
    audioInit();
    if (S.mode === 'intro') { S.mode = 'play'; return; }
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * W;
    if (Math.abs(x - S.keeper.x) < 120) input.shoo = true;
    else touchMove = x < S.keeper.x ? -1 : 1;
  });
  window.addEventListener('pointerup', () => { touchMove = 0; });

  function restart() {
    S.mode = 'play'; S.t = 0; S.F = 62;
    S.keeper = { x: 420, dir: 0, carry: 0, shooCd: 0, wave: 0 };
    S.woods.length = 0; S.moths.length = 0; S.embers.length = 0; S.puffs.length = 0;
    S.woodTimer = 2.0; S.mothTimer = 5.0;
    S.woodFed = 0; S.mothsShooed = 0; S.mothsHit = 0; S.shake = 0;
  }

  // ---- update ----
  function update(dt) {
    if (S.mode !== 'play') return;
    S.t += dt;
    // night progress
    const prog = Math.min(1, S.t / NIGHT_LEN);

    // fire decay, the real clock
    S.F -= F_DECAY * dt * (0.85 + 0.4 * prog); // slightly harsher toward dawn
    if (S.F <= 0) { S.F = 0; S.mode = 'lost'; return; }
    if (S.t >= NIGHT_LEN) { S.mode = 'won'; return; }

    // keeper movement
    const k = S.keeper;
    let mv = (input.right ? 1 : 0) - (input.left ? 1 : 0) + touchMove;
    mv = Math.max(-1, Math.min(1, mv));
    k.x += mv * KEEPER_SPEED * dt;
    k.x = Math.max(40, Math.min(W - 40, k.x));
    k.dir = mv;
    k.shooCd = Math.max(0, k.shooCd - dt);
    k.wave = Math.max(0, k.wave - dt);

    // shoo
    if (input.shoo) {
      input.shoo = false;
      if (k.shooCd <= 0) {
        k.shooCd = SHOO_CD; k.wave = 0.35;
        noiseBurst(0.18, 0.5, 900);
        for (const m of S.moths) {
          const dx = m.x - k.x, dy = m.y - 500;
          const d2 = dx * dx + dy * dy;
          if (d2 < SHOO_RADIUS * SHOO_RADIUS && m.flee <= 0) {
            const d = Math.sqrt(d2) || 1;
            m.flee = SHOO_FLEE_T;
            m.vx = (dx / d) * SHOO_FLEE_V; m.vy = (dy / d) * SHOO_FLEE_V - 40;
            S.mothsShooed++;
          }
        }
      }
    }

    // wood spawn
    S.woodTimer -= dt;
    if (S.woodTimer <= 0) { S.woodTimer = WOOD_INTERVAL * (0.8 + rng() * 0.5); spawnWood(); }

    // pickup wood / feed fire by contact
    for (let i = S.woods.length - 1; i >= 0; i--) {
      const w = S.woods[i];
      if (k.carry < CARRY_MAX && Math.abs(w.x - k.x) < 34) {
        S.woods.splice(i, 1); k.carry++;
        blip(500, 700, 0.08, 0.2, 'triangle');
      }
    }
    if (k.carry > 0 && Math.abs(k.x - FIRE_X) < 60) {
      const n = k.carry; k.carry = 0;
      S.F = Math.min(F_MAX, S.F + FEED_VALUE * n);
      S.woodFed += n; S.shake = 0.25;
      blip(140, 55, 0.16, 0.5); noiseBurst(0.25, 0.3, 300);
      for (let i = 0; i < 14 * n; i++) S.embers.push(ember(FIRE_X, FIRE_Y, true));
    }

    // moth drifts: clumps, interval ramps with night progress
    S.mothTimer -= dt;
    if (S.mothTimer <= 0) {
      const interval = 11 - 3.5 * prog; // 11s -> 7.5s between drifts
      S.mothTimer = interval * (0.8 + rng() * 0.4);
      const size = 3 + Math.floor(prog * 2 + rng() * 0.9); // 3 -> 4 per drift
      spawnClump(size);
    }

    // moths
    for (let i = S.moths.length - 1; i >= 0; i--) {
      const m = S.moths[i];
      m.ph += dt * 9;
      if (m.flee > 0) {
        m.flee -= dt;
        m.x += m.vx * dt; m.y += m.vy * dt;
        if (m.flee <= 0) { m.vx = 0; m.vy = 0; }
      } else {
        const dx = FIRE_X - m.x, dy = (FIRE_Y - 40) - m.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const sp = m.sp * (1 + 0.35 * prog);
        m.vx = (dx / d) * sp; m.vy = (dy / d) * sp;
        m.x += m.vx * dt + Math.sin(m.ph) * 24 * dt;
        m.y += m.vy * dt + Math.cos(m.ph * 1.3) * 16 * dt;
      }
      if (m.x < -60 || m.x > W + 60 || m.y < -60) { S.moths.splice(i, 1); continue; }
      const hx = m.x - FIRE_X, hy = m.y - (FIRE_Y - 30);
      if (hx * hx + hy * hy < 34 * 34) {
        S.moths.splice(i, 1);
        S.F = Math.max(0, S.F - MOTH_HIT_DMG);
        S.mothsHit++; S.shake = 0.35;
        blip(300, 90, 0.2, 0.35, 'sawtooth');
        for (let j = 0; j < 10; j++) S.puffs.push({ x: m.x, y: m.y, vx: (rng() - 0.5) * 90, vy: -rng() * 60, life: 0.7, max: 0.7 });
      }
    }

    // embers from fire, count tied to F
    if (rng() < dt * (4 + S.F * 0.35)) S.embers.push(ember(FIRE_X + (rng() - 0.5) * 26, FIRE_Y, false));
    for (let i = S.embers.length - 1; i >= 0; i--) {
      const e = S.embers[i];
      e.x += e.vx * dt; e.y += e.vy * dt; e.vy -= 14 * dt; e.life -= dt;
      if (e.life <= 0) S.embers.splice(i, 1);
    }
    for (let i = S.puffs.length - 1; i >= 0; i--) {
      const p = S.puffs[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0) S.puffs.splice(i, 1);
    }
    // snow
    for (const s of S.snow) {
      s.y += s.v * dt; s.x += Math.sin(s.ph + S.t * 0.5) * 8 * dt;
      if (s.y > H) { s.y = -6; s.x = rng() * W; }
    }
    S.shake = Math.max(0, S.shake - dt);

    // audio levels
    if (crackleGain) crackleGain.gain.value = muted ? 0 : 0.02 + (S.F / F_MAX) * 0.12;
    if (windGain) windGain.gain.value = muted ? 0 : 0.04 + 0.03 * Math.sin(S.t * 0.23) + 0.02 * prog;
  }

  function ember(x, y, burst) {
    return {
      x, y,
      vx: (rng() - 0.5) * (burst ? 130 : 26),
      vy: -(30 + rng() * (burst ? 160 : 60)),
      life: 0.6 + rng() * (burst ? 1.1 : 1.8),
      max: 2.2, r: 1 + rng() * (burst ? 2.4 : 1.6),
    };
  }

  // ---- render ----
  function render() {
    ctx.save();
    if (S.shake > 0) ctx.translate((rng() - 0.5) * 6 * S.shake * 3, (rng() - 0.5) * 4 * S.shake * 3);

    // sky, lightens toward dawn
    const prog = Math.min(1, S.t / NIGHT_LEN);
    const dawn = Math.max(0, (prog - 0.82) / 0.18);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, mix('#050818', '#3a2b4d', dawn));
    g.addColorStop(0.7, mix('#0a1024', '#7a4a3a', dawn));
    g.addColorStop(1, mix('#101528', '#c98a4a', dawn));
    ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);

    // stars fade at dawn
    ctx.globalAlpha = 1 - dawn * 0.9;
    for (const st of stars) {
      const a = 0.4 + 0.6 * Math.abs(Math.sin(st.tw + S.t * 0.7));
      ctx.fillStyle = `rgba(220,228,255,${a * 0.8})`;
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }
    ctx.globalAlpha = 1;

    // tree line silhouettes
    ctx.fillStyle = '#060a14';
    ctx.beginPath(); ctx.moveTo(-20, GROUND_Y + 4);
    for (let x = -20; x <= W + 20; x += 40) {
      const h = 90 + 60 * Math.sin(x * 0.013) + 30 * Math.sin(x * 0.031);
      ctx.lineTo(x, GROUND_Y - h);
      ctx.lineTo(x + 20, GROUND_Y - h - 26);
      ctx.lineTo(x + 40, GROUND_Y - h);
    }
    ctx.lineTo(W + 20, GROUND_Y + 4); ctx.closePath(); ctx.fill();

    // snow ground
    ctx.fillStyle = mix('#141b2e', '#2a2438', dawn);
    ctx.fillRect(-20, GROUND_Y, W + 40, H - GROUND_Y + 20);

    // snow fall
    ctx.fillStyle = 'rgba(210,220,240,0.5)';
    for (const s of S.snow) ctx.fillRect(s.x, s.y, 2, 2);

    // wood pieces
    for (const w of S.woods) {
      const bob = Math.sin(S.t * 2 + w.bob) * 2;
      ctx.save(); ctx.translate(w.x, GROUND_Y - 8 + bob);
      ctx.rotate(0.2 * Math.sin(w.bob));
      ctx.fillStyle = '#6b4a2f';
      ctx.fillRect(-14, -5, 28, 10);
      ctx.fillStyle = '#8a6238';
      ctx.fillRect(-14, -5, 28, 3);
      ctx.beginPath(); ctx.arc(-14, 0, 5, 0, 6.29); ctx.fillStyle = '#a9835a'; ctx.fill();
      ctx.restore();
    }

    // fire glow (behind fire)
    const fr = 60 + S.F * 2.2;
    const glow = ctx.createRadialGradient(FIRE_X, FIRE_Y - 16, 8, FIRE_X, FIRE_Y - 16, fr);
    glow.addColorStop(0, `rgba(255,190,90,${0.5 * (S.F / F_MAX) + 0.12})`);
    glow.addColorStop(0.5, `rgba(255,120,40,${0.22 * (S.F / F_MAX)})`);
    glow.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(FIRE_X - fr, FIRE_Y - 16 - fr, fr * 2, fr * 2);

    // logs
    ctx.fillStyle = '#4a3320';
    ctx.save(); ctx.translate(FIRE_X, FIRE_Y);
    ctx.rotate(0.3); ctx.fillRect(-30, -4, 60, 9);
    ctx.rotate(-0.6); ctx.fillRect(-30, -4, 60, 9);
    ctx.restore();

    // flame
    if (S.F > 0) {
      const fh = 14 + S.F * 0.85 + Math.sin(S.t * 11) * 4 * (S.F / 60);
      const fw = 12 + S.F * 0.28;
      const fg = ctx.createLinearGradient(0, FIRE_Y, 0, FIRE_Y - fh);
      fg.addColorStop(0, '#ff5a1a'); fg.addColorStop(0.55, '#ffb43c'); fg.addColorStop(1, 'rgba(255,240,180,0.9)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(FIRE_X - fw, FIRE_Y);
      ctx.quadraticCurveTo(FIRE_X - fw * 0.7, FIRE_Y - fh * 0.55, FIRE_X + Math.sin(S.t * 7) * 5, FIRE_Y - fh);
      ctx.quadraticCurveTo(FIRE_X + fw * 0.7, FIRE_Y - fh * 0.55, FIRE_X + fw, FIRE_Y);
      ctx.closePath(); ctx.fill();
      // inner flame
      const ih = fh * 0.5;
      ctx.fillStyle = 'rgba(255,230,160,0.85)';
      ctx.beginPath();
      ctx.moveTo(FIRE_X - fw * 0.45, FIRE_Y);
      ctx.quadraticCurveTo(FIRE_X, FIRE_Y - ih * 0.6, FIRE_X + Math.cos(S.t * 9) * 3, FIRE_Y - ih);
      ctx.quadraticCurveTo(FIRE_X + fw * 0.45, FIRE_Y - ih * 0.6, FIRE_X + fw * 0.45, FIRE_Y);
      ctx.closePath(); ctx.fill();
    }

    // embers
    for (const e of S.embers) {
      const a = Math.max(0, e.life / e.max);
      ctx.fillStyle = `rgba(255,${140 + Math.floor(80 * a)},60,${a})`;
      ctx.fillRect(e.x, e.y, e.r, e.r);
    }
    // moth-death puffs
    for (const p of S.puffs) {
      ctx.fillStyle = `rgba(190,200,230,${0.5 * p.life / p.max})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3 + (1 - p.life / p.max) * 8, 0, 6.29); ctx.fill();
    }

    // moths (pale, cold)
    for (const m of S.moths) {
      const wob = Math.sin(m.ph) * 0.4;
      ctx.save(); ctx.translate(m.x, m.y); ctx.rotate(wob * 0.4);
      const flutter = 1 + Math.sin(m.ph * 2.2) * 0.35;
      ctx.fillStyle = m.flee > 0 ? 'rgba(200,215,245,0.85)' : 'rgba(170,190,235,0.95)';
      ctx.beginPath(); ctx.ellipse(-6 * flutter, 0, 7 * flutter, 4.5, -0.5, 0, 6.29); ctx.fill();
      ctx.beginPath(); ctx.ellipse(6 * flutter, 0, 7 * flutter, 4.5, 0.5, 0, 6.29); ctx.fill();
      ctx.fillStyle = '#dfe8ff';
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, 6.29); ctx.fill();
      ctx.restore();
    }

    // keeper, small hooded silhouette with lantern glow
    const k = S.keeper;
    const kg = ctx.createRadialGradient(k.x, 505, 4, k.x, 505, 60);
    kg.addColorStop(0, 'rgba(255,210,130,0.25)'); kg.addColorStop(1, 'rgba(255,210,130,0)');
    ctx.fillStyle = kg; ctx.fillRect(k.x - 60, 445, 120, 120);
    ctx.save(); ctx.translate(k.x, GROUND_Y - 4);
    if (k.dir < 0) ctx.scale(-1, 1);
    // cloak
    ctx.fillStyle = '#1d2739';
    ctx.beginPath();
    ctx.moveTo(-16, 0); ctx.quadraticCurveTo(-18, -40, -7, -58);
    ctx.quadraticCurveTo(0, -66, 7, -58);
    ctx.quadraticCurveTo(18, -40, 16, 0);
    ctx.closePath(); ctx.fill();
    // hood shadow face
    ctx.fillStyle = '#0c1220';
    ctx.beginPath(); ctx.arc(0, -52, 7.5, 0, 6.29); ctx.fill();
    // carried wood
    for (let i = 0; i < k.carry; i++) {
      ctx.fillStyle = '#7a5533';
      ctx.fillRect(-11 + i * 8, -46, 6, 18);
    }
    // wave arm
    if (k.wave > 0) {
      ctx.strokeStyle = '#2c3a55'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(4, -40);
      const lift = Math.sin((0.35 - k.wave) / 0.35 * Math.PI);
      ctx.lineTo(26, -44 - 18 * lift); ctx.stroke();
      // wave arc
      ctx.strokeStyle = `rgba(210,225,255,${0.55 * lift})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, -44, 30 + (1 - lift) * 26, -1.1, 0.6); ctx.stroke();
    }
    ctx.restore();

    // darkness vignette, closes in as the fire shrinks
    const darkR = 180 + S.F * 6.5;
    const dk = ctx.createRadialGradient(FIRE_X, FIRE_Y - 20, darkR * 0.42, FIRE_X, FIRE_Y - 20, darkR);
    const edge = 0.88 - 0.4 * (S.F / F_MAX) - dawn * 0.55;
    dk.addColorStop(0, 'rgba(2,4,12,0)');
    dk.addColorStop(1, `rgba(2,4,12,${Math.max(0.12, edge)})`);
    ctx.fillStyle = dk; ctx.fillRect(-20, -20, W + 40, H + 40);

    // HUD
    ctx.fillStyle = 'rgba(220,228,245,0.85)';
    ctx.font = '16px monospace'; ctx.textAlign = 'left';
    const mm = Math.floor(Math.max(0, NIGHT_LEN - S.t) / 60), ss = Math.floor(Math.max(0, NIGHT_LEN - S.t) % 60);
    ctx.fillText(`night ends in ${mm}:${ss < 10 ? '0' : ''}${ss}`, 18, 30);
    // fire meter
    ctx.strokeStyle = 'rgba(220,228,245,0.4)'; ctx.strokeRect(18, 40, 160, 12);
    ctx.fillStyle = S.F > 30 ? '#ffb43c' : '#ff5a4a';
    ctx.fillRect(19, 41, 158 * (S.F / F_MAX), 10);
    ctx.fillStyle = 'rgba(220,228,245,0.7)';
    ctx.fillText(`wood ${k.carry}/${CARRY_MAX}`, 18, 70);
    if (muted) { ctx.fillText('muted (M)', W - 110, 30); }

    ctx.restore();

    // overlays
    if (S.mode === 'intro') {
      overlay('EMBERWATCH', [
        'You keep the last fire of the night.',
        'It is always dying. Dawn is 3 minutes away.',
        '',
        'Move: ← → or A D. Walk over wood to carry it,',
        'walk to the fire to feed it.',
        'SPACE: wave off the frost moths. They smother the flame.',
        '',
        (window.innerHeight > window.innerWidth ? 'rotate your device for a bigger fire.' : ''),
        'press any key',
      ]);
    } else if (S.mode === 'lost') {
      overlay('The dark took the fire.', [
        `night ${Math.floor(S.t)}s, wood fed ${S.woodFed}, moths shooed ${S.mothsShooed}, hits ${S.mothsHit}`,
        '', 'R to try the night again',
      ]);
    } else if (S.mode === 'won') {
      const rank = S.mothsHit <= 3 ? 'S' : S.mothsHit <= 8 ? 'A' : S.mothsHit <= 15 ? 'B' : 'C';
      overlay('Dawn. The fire held.', [
        `dawn rank ${rank}. Wood fed ${S.woodFed}, moths shooed ${S.mothsShooed}, hits taken ${S.mothsHit}`,
        '', 'R to keep another night',
      ]);
    }
  }

  function overlay(title, lines) {
    ctx.fillStyle = 'rgba(2,4,10,0.72)'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd9a0';
    ctx.font = 'bold 54px Georgia, serif';
    ctx.fillText(title, W / 2, 240);
    ctx.fillStyle = 'rgba(224,230,246,0.92)';
    ctx.font = '22px Georgia, serif';
    lines.forEach((l, i) => ctx.fillText(l, W / 2, 320 + i * 34));
    ctx.textAlign = 'left';
  }

  function mix(c1, c2, f) {
    const p = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    const a = p(c1), b = p(c2);
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
  }

  // ---- main loop ----
  let last = performance.now();
  function frame(now) {
    let dt = Math.min(0.05, (now - last) / 1000) * S.timescale;
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- debug/test hooks (not part of play) ----
  window.EMBER = {
    state() {
      return {
        mode: S.mode, t: S.t, F: S.F,
        keeperX: S.keeper.x, carry: S.keeper.carry,
        woods: S.woods.map(w => w.x),
        moths: S.moths.map(m => ({ x: m.x, y: m.y, flee: m.flee })),
        woodFed: S.woodFed, mothsShooed: S.mothsShooed, mothsHit: S.mothsHit,
      };
    },
    timescale(k2) { S.timescale = k2; },
    key(code, down) { if (S.mode === 'intro' && down) { S.mode = 'play'; return; } keymap(code, down); },
    start() { S.mode = 'play'; },
    spawnMoth, spawnWood,
    setFire(v) { S.F = v; },
    setNight(t2) { S.t = t2; },
    reseed(n) { _rstate = (n >>> 0) || 1; restart(); },
  };
})();
