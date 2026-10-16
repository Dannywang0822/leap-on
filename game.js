/**
 * 跃·不停 / Leap On
 * Spec: tap anywhere = fixed vertical jump arc (no aim). Platforms move for challenge.
 */
(function () {
  "use strict";

  const W = 390;
  const H = 700;
  const BEST_KEY = "leap-on-best";

  const GRAVITY = 2200;
  const JUMP_VY = -920; // apex ≈ 192px
  const PLAYER_W = 28;
  const PLAYER_H = 36;
  const PLATFORM_H = 16;
  const CAMERA_LERP = 8;
  /** Keep a few px of foot on the pad when clamping spawn offset. */
  const SPAWN_MARGIN = 8;

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const overlay = document.getElementById("overlay");
  const overlayTitle = document.getElementById("overlay-title");
  const overlaySub = document.getElementById("overlay-sub");
  const overlayMsg = document.getElementById("overlay-msg");
  const overlayScore = document.getElementById("overlay-score");
  const btnStart = document.getElementById("btn-start");

  let best = 0;
  try {
    best = Number(localStorage.getItem(BEST_KEY) || 0) || 0;
    const legacy = Number(localStorage.getItem("leapOnHighScore") || 0) || 0;
    if (legacy > best) {
      best = legacy;
      localStorage.setItem(BEST_KEY, String(best));
    }
  } catch (_) {}
  bestEl.textContent = String(best);

  // --- tiny Web Audio beeps (lazy AudioContext) ---
  let audioCtx = null;
  function ensureAudio() {
    if (audioCtx) return audioCtx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    } catch (_) {
      return null;
    }
    return audioCtx;
  }

  function beep(freq, dur, type, gain) {
    const ac = ensureAudio();
    if (!ac) return;
    try {
      if (ac.state === "suspended") ac.resume();
      const t0 = ac.currentTime;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type || "square";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(gain == null ? 0.05 : gain, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + (dur || 0.08));
      osc.connect(g);
      g.connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + (dur || 0.08) + 0.02);
    } catch (_) {}
  }

  const player = {
    x: W / 2,
    y: H - 120,
    vx: 0,
    vy: 0,
    w: PLAYER_W,
    h: PLAYER_H,
    onGround: true,
    scaleY: 1,
    landPulse: 0,
    platOffset: 0,
  };

  /** @type {Array<{id:number,x:number,y:number,w:number,h:number,vx:number,amp:number,baseX:number,phase:number,brittle:boolean,vanishAt:number|null,gone:boolean}>} */
  let platforms = [];
  let nextPlatformId = 1;
  let score = 0;
  let cameraY = 0;
  let running = false;
  let gameOver = false;
  let lastTs = 0;
  let particles = [];
  let standingPlatform = null;
  /** Highest climb (smallest y) successfully landed — reject landings below this. */
  let climbY = Infinity;

  function platformWidthForScore(s) {
    if (s <= 5) return 120 + Math.random() * 20;
    if (s <= 8) return 100 + Math.random() * 20;
    if (s <= 14) return 78 + Math.random() * 22;
    if (s <= 25) return 62 + Math.random() * 18;
    return 52 + Math.random() * 14;
  }

  function gapForScore(s) {
    if (s <= 5) return 115 + Math.random() * 15;
    if (s <= 8) return 125 + Math.random() * 20;
    if (s <= 14) return 135 + Math.random() * 25;
    if (s <= 25) return 145 + Math.random() * 25;
    return 150 + Math.random() * 30;
  }

  function moveSpeedForScore(s) {
    // Spec: platforms move near landing; early friendly, then speed up
    if (s <= 4) return 0;
    if (s <= 8) return 45 + Math.random() * 35;
    if (s <= 14) return 75 + Math.random() * 45;
    if (s <= 25) return 110 + Math.random() * 50;
    return 140 + Math.random() * 60;
  }

  function moveAmpForScore(s) {
    if (s <= 4) return 0;
    if (s <= 8) return 30 + Math.random() * 22;
    if (s <= 14) return 42 + Math.random() * 30;
    return 52 + Math.random() * 40;
  }

  function shouldBrittle(s) {
    if (s < 15) return false;
    const p = Math.min(0.4, 0.2 + (s - 15) * 0.015);
    return Math.random() < p;
  }

  /**
   * Max |next.x - prev.x| so a straight-up jump (vx=0) from some standing
   * spot on prev can still land on next (player center ≈ standing x).
   * Reachable on prev: ±(prev.w/2 - PLAYER_W/2); next accepts ± next.w/2.
   */
  function maxSafeHorizOffset(prevW, nextW) {
    const raw = prevW / 2 + nextW / 2 - PLAYER_W / 2 - SPAWN_MARGIN;
    return Math.max(10, raw);
  }

  /**
   * Soft variety cap by score (fraction of the hard safe max).
   * Early: gentler offsets; late: use most of the safe budget — never exceed it.
   */
  function offsetBudget(s, safeMax) {
    let factor = 0.9;
    if (s <= 5) factor = 0.5;
    else if (s <= 8) factor = 0.65;
    else if (s <= 14) factor = 0.8;
    else if (s <= 25) factor = 0.9;
    else factor = 0.95;
    return safeMax * factor;
  }

  function makePlatform(x, y, w, scoreHint) {
    const speed = moveSpeedForScore(scoreHint);
    let amp = speed > 0 ? moveAmpForScore(scoreHint) : 0;
    let baseX = x;
    const half = w / 2;
    // Keep the whole oscillation inside the screen
    const minBase = half + amp + 8;
    const maxBase = W - half - amp - 8;
    if (minBase > maxBase) {
      amp = Math.max(0, (W - w - 16) / 2);
      baseX = W / 2;
    } else {
      baseX = Math.max(minBase, Math.min(maxBase, baseX));
    }
    const dir = Math.random() < 0.5 ? -1 : 1;
    return {
      id: nextPlatformId++,
      x: baseX,
      y,
      w,
      h: PLATFORM_H,
      vx: speed * dir,
      amp,
      baseX,
      phase: Math.random() * Math.PI * 2,
      brittle: shouldBrittle(scoreHint),
      vanishAt: null,
      gone: false,
    };
  }

  function spawnNext(prev, scoreHint) {
    const gap = gapForScore(scoreHint);
    const w = platformWidthForScore(scoreHint);
    const safe = maxSafeHorizOffset(prev.w, w);
    const budget = offsetBudget(scoreHint, safe);
    const offset = (Math.random() * 2 - 1) * budget;
    let x = prev.x + offset;
    // Re-clamp after screen edges so fairness still holds vs prev.x
    const half = w / 2;
    x = Math.max(half + 12, Math.min(W - half - 12, x));
    const dx = x - prev.x;
    if (Math.abs(dx) > safe) {
      x = prev.x + Math.sign(dx || 1) * safe;
      x = Math.max(half + 12, Math.min(W - half - 12, x));
    }
    return makePlatform(x, prev.y - gap, w, scoreHint);
  }

  function ensurePlatforms() {
    if (!platforms.length) return;
    let topMost = platforms.reduce((m, p) => (p.y < m.y ? p : m), platforms[0]);
    let guard = 0;
    while (topMost.y > cameraY - 100 && guard++ < 40) {
      const next = spawnNext(topMost, score);
      platforms.push(next);
      topMost = next;
    }
    // Cull far below camera; also drop pads well below climb so you can't farm
    platforms = platforms.filter(
      (p) => !p.gone && p.y < cameraY + H + 200 && p.y < climbY + 280
    );
  }

  function resetGame() {
    ensureAudio();
    score = 0;
    scoreEl.textContent = "0";
    nextPlatformId = 1;
    platforms = [];
    particles = [];
    gameOver = false;
    running = true;
    cameraY = 0;
    climbY = Infinity;
    player.scaleY = 1;
    player.landPulse = 0;
    player.vx = 0;
    player.vy = 0;
    player.onGround = true;
    player.platOffset = 0;

    const groundY = H - 100;
    const ground = makePlatform(W / 2, groundY, 160, 0);
    ground.brittle = false;
    ground.vx = 0;
    ground.amp = 0;
    platforms.push(ground);

    player.x = ground.x;
    player.y = ground.y - player.h / 2;
    standingPlatform = ground;
    climbY = ground.y;

    let last = ground;
    for (let i = 0; i < 6; i++) {
      last = spawnNext(last, i);
      platforms.push(last);
    }

    overlay.classList.add("hidden");
    lastTs = performance.now();
  }

  function triggerGameOver() {
    if (gameOver) return;
    gameOver = true;
    running = false;
    player.onGround = false;
    standingPlatform = null;
    beep(110, 0.22, "sawtooth", 0.06);

    if (score > best) {
      best = score;
      try {
        localStorage.setItem(BEST_KEY, String(best));
      } catch (_) {}
      bestEl.textContent = String(best);
    }

    overlayTitle.textContent = "结束了";
    overlaySub.textContent = "GAME OVER";
    overlayMsg.innerHTML =
      score > 0 && score >= best ? "新纪录！再来一把？" : "掉下去了。再来一把？";
    overlayScore.classList.remove("hidden");
    overlayScore.textContent = "本局 " + score + " · 最高 " + best;
    btnStart.textContent = "再来一把";
    overlay.classList.remove("hidden");
  }

  function jump() {
    if (!running || gameOver || !player.onGround) return;
    player.onGround = false;
    player.vy = JUMP_VY;
    player.vx = 0; // fixed arc — no horizontal aim
    standingPlatform = null;
    player.platOffset = 0;
    player.scaleY = 1.15;
    beep(520, 0.06, "square", 0.045);
  }

  function landOn(plat) {
    // Only land on a platform higher than last stand (smaller y). Else fall = game over.
    if (!(plat.y < climbY - 2)) {
      triggerGameOver();
      return;
    }

    player.onGround = true;
    player.vy = 0;
    player.vx = 0;
    player.y = plat.y - player.h / 2;
    const left = plat.x - plat.w / 2 + player.w / 2;
    const right = plat.x + plat.w / 2 - player.w / 2;
    player.x = Math.max(left, Math.min(right, player.x));
    standingPlatform = plat;
    player.platOffset = player.x - plat.x;
    climbY = plat.y;
    score += 1;
    scoreEl.textContent = String(score);
    player.landPulse = 1;
    player.scaleY = 0.72;
    beep(320, 0.05, "triangle", 0.05);

    for (let i = 0; i < 8; i++) {
      particles.push({
        x: player.x + (Math.random() - 0.5) * 20,
        y: plat.y,
        vx: (Math.random() - 0.5) * 160,
        vy: -40 - Math.random() * 80,
        life: 0.35 + Math.random() * 0.25,
        color: plat.brittle ? "#ff9a5c" : "#7ec8ff",
      });
    }

    if (plat.brittle && plat.vanishAt == null) {
      plat.vanishAt = performance.now() + 600;
    }
    ensurePlatforms();
  }

  function updatePlatforms(dt, now) {
    for (const p of platforms) {
      if (p.gone) continue;
      if (p.amp > 0 && p.vx !== 0) {
        p.phase += (Math.abs(p.vx) / Math.max(p.amp, 1)) * dt;
        p.x = p.baseX + Math.sin(p.phase) * p.amp;
      }
      if (p.vanishAt != null && now >= p.vanishAt) {
        p.gone = true;
        if (standingPlatform && standingPlatform.id === p.id) {
          player.onGround = false;
          standingPlatform = null;
          player.platOffset = 0;
        }
        for (let i = 0; i < 6; i++) {
          particles.push({
            x: p.x + (Math.random() - 0.5) * p.w,
            y: p.y,
            vx: (Math.random() - 0.5) * 100,
            vy: (Math.random() - 0.5) * 60,
            life: 0.3,
            color: "#e8a060",
          });
        }
      }
    }
    platforms = platforms.filter((p) => !p.gone);
  }

  function updatePlayer(dt) {
    if (player.landPulse > 0) {
      player.landPulse = Math.max(0, player.landPulse - dt * 4);
    }
    player.scaleY += (1 - player.scaleY) * Math.min(1, dt * 12);

    if (player.onGround && standingPlatform) {
      player.x = standingPlatform.x + player.platOffset;
      const left = standingPlatform.x - standingPlatform.w / 2 + player.w / 2;
      const right = standingPlatform.x + standingPlatform.w / 2 - player.w / 2;
      player.x = Math.max(left, Math.min(right, player.x));
      player.platOffset = player.x - standingPlatform.x;
      player.y = standingPlatform.y - player.h / 2;
      player.vy = 0;
      player.vx = 0;
    } else {
      player.vy += GRAVITY * dt;
      // vx stays 0 — no air steer
      player.y += player.vy * dt;

      if (player.vy > 0) {
        const footY = player.y + player.h / 2;
        const prevFoot = footY - player.vy * dt;
        for (const p of platforms) {
          if (p.gone) continue;
          const top = p.y;
          const left = p.x - p.w / 2;
          const right = p.x + p.w / 2;
          if (
            prevFoot <= top + 4 &&
            footY >= top &&
            player.x >= left &&
            player.x <= right
          ) {
            landOn(p);
            break;
          }
        }
      }
    }

    const targetCam = player.y - H * 0.58;
    cameraY += (targetCam - cameraY) * Math.min(1, CAMERA_LERP * dt);
    if (cameraY > 0) cameraY *= 0.9;

    if (player.y - cameraY > H + 40) {
      triggerGameOver();
    }
  }

  function updateParticles(dt) {
    for (const pt of particles) {
      pt.life -= dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.vy += 400 * dt;
    }
    particles = particles.filter((p) => p.life > 0);
  }

  function worldToScreen(wx, wy) {
    return { x: wx, y: wy - cameraY };
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#0a1628");
    g.addColorStop(0.5, "#0b1220");
    g.addColorStop(1, "#070b14");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(168, 192, 240, 0.15)";
    for (let i = 0; i < 40; i++) {
      const sx = (i * 97) % W;
      const sy = ((i * 53 + Math.floor(cameraY * 0.15)) % H + H) % H;
      ctx.fillRect(sx, sy, 2, 2);
    }
  }

  function drawPlatform(p) {
    const s = worldToScreen(p.x, p.y);
    const x = s.x - p.w / 2;
    const y = s.y;
    if (y < -40 || y > H + 40) return;

    if (p.brittle) {
      ctx.fillStyle = "#c45a2a";
      ctx.strokeStyle = "#ff9a5c";
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, p.w, p.h, 6);
      ctx.fill();
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(255, 200, 140, 0.5)";
      ctx.beginPath();
      ctx.moveTo(x + p.w * 0.3, y + 2);
      ctx.lineTo(x + p.w * 0.45, y + p.h - 2);
      ctx.moveTo(x + p.w * 0.6, y + 1);
      ctx.lineTo(x + p.w * 0.7, y + p.h - 1);
      ctx.stroke();
      if (p.vanishAt != null) {
        const left = Math.max(0, (p.vanishAt - performance.now()) / 600);
        ctx.fillStyle =
          "rgba(255, 80, 40, " + (0.35 + (1 - left) * 0.4) + ")";
        roundRect(ctx, x, y, p.w, p.h, 6);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = "#3d6bb3";
      roundRect(ctx, x, y, p.w, p.h, 6);
      ctx.fill();
      ctx.fillStyle = "#7ec8ff";
      roundRect(ctx, x, y, p.w, 5, 4);
      ctx.fill();
    }

    if (p.amp > 0) {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      const dir = Math.cos(p.phase) >= 0 ? 1 : -1;
      const cx = s.x;
      const cy = y + p.h / 2;
      ctx.beginPath();
      if (dir > 0) {
        ctx.moveTo(cx - 6, cy - 4);
        ctx.lineTo(cx + 4, cy);
        ctx.lineTo(cx - 6, cy + 4);
      } else {
        ctx.moveTo(cx + 6, cy - 4);
        ctx.lineTo(cx - 4, cy);
        ctx.lineTo(cx + 6, cy + 4);
      }
      ctx.fill();
    }
  }

  function drawPlayer() {
    const s = worldToScreen(player.x, player.y);
    const hw = player.w / 2;
    const hh = (player.h / 2) * player.scaleY;
    const top = s.y - hh;
    const bot = s.y + hh;

    if (player.onGround) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.beginPath();
      ctx.ellipse(s.x, bot + 4, hw * 0.9, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#e8f0ff";
    roundRect(ctx, s.x - hw, top, player.w, hh * 2, 8);
    ctx.fill();
    ctx.fillStyle = "#4aa3e8";
    roundRect(ctx, s.x - hw + 4, top + 6, player.w - 8, 8, 4);
    ctx.fill();
    ctx.fillStyle = "#0b1220";
    ctx.beginPath();
    ctx.arc(s.x - 5, top + hh * 2 * 0.45, 2.5, 0, Math.PI * 2);
    ctx.arc(s.x + 5, top + hh * 2 * 0.45, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawParticles() {
    for (const pt of particles) {
      const s = worldToScreen(pt.x, pt.y);
      ctx.globalAlpha = Math.max(0, pt.life * 2);
      ctx.fillStyle = pt.color;
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
      ctx.globalAlpha = 1;
    }
  }

  function drawHint() {
    if (!running || score > 0 || !player.onGround) return;
    ctx.fillStyle = "rgba(168,192,240,0.55)";
    ctx.font = "14px system-ui,sans-serif";
    ctx.textAlign = "center";
    const s = worldToScreen(player.x, player.y);
    ctx.fillText("点按跳跃", s.x, s.y - 50);
  }

  function render() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cw = Math.max(1, Math.floor(rect.width * dpr));
    const ch = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const scale = Math.min(cw / W, ch / H);
    const ox = (cw - W * scale) / 2;
    const oy = (ch - H * scale) / 2;
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.clearRect(-ox / scale, -oy / scale, cw / scale, ch / scale);

    drawBackground();
    for (const p of platforms) drawPlatform(p);
    drawParticles();
    drawPlayer();
    drawHint();
  }

  function frame(ts) {
    const dt = Math.min(0.033, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;
    if (running && !gameOver) {
      updatePlatforms(dt, ts);
      updatePlayer(dt);
      updateParticles(dt);
      ensurePlatforms();
    } else {
      updateParticles(dt);
    }
    render();
    requestAnimationFrame(frame);
  }

  function onPointer(e) {
    if (e && e.cancelable) e.preventDefault();
    if (overlay && !overlay.classList.contains("hidden")) return;
    jump();
  }

  canvas.addEventListener("pointerdown", onPointer, { passive: false });
  canvas.addEventListener(
    "touchstart",
    function (e) {
      if (e.cancelable) e.preventDefault();
      if (overlay && !overlay.classList.contains("hidden")) return;
      jump();
    },
    { passive: false }
  );

  window.addEventListener("keydown", function (e) {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") {
      e.preventDefault();
      if (overlay && !overlay.classList.contains("hidden")) {
        if (e.code === "Space") btnStart.click();
        return;
      }
      jump();
    }
  });

  document.addEventListener(
    "touchmove",
    function (e) {
      if (e.cancelable) e.preventDefault();
    },
    { passive: false }
  );
  document.addEventListener(
    "gesturestart",
    function (e) {
      e.preventDefault();
    },
    { passive: false }
  );

  btnStart.addEventListener("click", function (e) {
    e.stopPropagation();
    resetGame();
  });
  btnStart.addEventListener(
    "touchend",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      resetGame();
    },
    { passive: false }
  );

  overlayTitle.textContent = "跃·不停";
  overlaySub.textContent = "Leap On";
  overlayMsg.innerHTML =
    "点按跳跃，落稳平台。<br/>越跳越难，一失足就重来。";
  overlayScore.classList.add("hidden");
  btnStart.textContent = "开始";
  overlay.classList.remove("hidden");

  function showIdleScene() {
    score = 0;
    platforms = [];
    const ground = makePlatform(W / 2, H - 100, 160, 0);
    ground.brittle = false;
    ground.vx = 0;
    ground.amp = 0;
    platforms.push(ground);
    player.x = ground.x;
    player.y = ground.y - player.h / 2;
    player.onGround = true;
    standingPlatform = ground;
    climbY = ground.y;
    cameraY = 0;
  }
  showIdleScene();
  requestAnimationFrame(frame);

  window.__LEAP_ON__ = {
    W,
    H,
    BEST_KEY,
    PLAYER_W,
    SPAWN_MARGIN,
    maxSafeHorizOffset,
    jump,
    resetGame,
    triggerGameOver,
    getState: function () {
      return {
        score,
        best,
        running,
        gameOver,
        onGround: player.onGround,
        platformCount: platforms.length,
        playerY: player.y,
        climbY,
        playerVx: player.vx,
      };
    },
  };
})();
