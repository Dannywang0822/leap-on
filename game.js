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

  const BEST_KEY_RANDOM = "leap-on-best-random";
  const FLOORS_PER_LEVEL = 10;
  /** Rules ordered easy -> hard; pool unlocks gradually. */
  const RULES = [
    { id: "stars", name: "摘星", desc: "平台上方有星星，碰到 +2 分", color: "#ffd84a" },
    { id: "lowg", name: "低重力", desc: "跳得更高、落得更慢，看准时机", color: "#b48cff" },
    { id: "ice", name: "冰面", desc: "落地会打滑，滑出边缘就掉下去", color: "#9fe8ff" },
    { id: "move", name: "疾行平台", desc: "所有平台快速左右移动", color: "#7ec8ff" },
    { id: "narrow", name: "窄台", desc: "平台变窄，站稳再跳", color: "#ff7eb6" },
    { id: "wind", name: "侧风", desc: "空中被风吹偏，平台已按风向错位", color: "#8cf0b4" },
    { id: "crumble", name: "碎裂", desc: "落地 1 秒后平台碎掉，快跳！", color: "#ff9a5c" },
    { id: "timer", name: "限时", desc: "12 秒内爬完本关 10 层", color: "#ff5a5a" },
    { id: "blink", name: "闪烁", desc: "平台忽隐忽现，只在亮起时能站", color: "#f0f0a0" },
  ];
  const WARMUP = { id: "warmup", name: "热身", desc: "普通平台，熟悉一下节奏", color: "#a8c0f0" };
  let mode = "random"; // "random" | "classic"
  let levelRules = []; // index = level
  let banner = null; // {rule, level, t}
  let stars = [];
  let levelTimer = 0;
  let floorCounter = 0;
  let bestRandom = 0;
  try { bestRandom = Number(localStorage.getItem(BEST_KEY_RANDOM) || 0) || 0; } catch (_) {}

  function levelOf(floor) { return floor <= 0 ? 0 : Math.floor((floor - 1) / FLOORS_PER_LEVEL); }
  function ruleFor(level) {
    if (mode !== "random") return null;
    while (levelRules.length <= level) {
      const L = levelRules.length;
      if (L === 0) { levelRules.push(WARMUP); continue; }
      const poolSize = Math.min(RULES.length, 2 + L); // L1:3 rules ... L7+: all
      const prev = levelRules[L - 1];
      const pool = RULES.slice(0, poolSize).filter((r) => r !== prev);
      // bias toward newest unlocked rule the level it unlocks
      let pick = pool[Math.floor(Math.random() * pool.length)];
      const fresh = RULES[poolSize - 1];
      if (L >= 2 && fresh !== prev && poolSize === 2 + L && Math.random() < 0.5) pick = fresh;
      levelRules.push(pick);
    }
    return levelRules[level];
  }
  function ruleId(level) { const r = ruleFor(level); return r ? r.id : null; }
  /** Rule governing the jump physics now = rule of the next floor above. */
  function activeRuleId() {
    const fl = standingPlatform ? standingPlatform.floor : player.lastFloor || 0;
    return ruleId(levelOf(fl + 1));
  }
  const WIND_SPEED = 70;
  let windDirs = {};
  function windFor(level) {
    if (ruleId(level) !== "wind") return 0;
    if (windDirs[level] == null) windDirs[level] = Math.random() < 0.5 ? -1 : 1;
    return WIND_SPEED * windDirs[level];
  }
  function physFor(rid) {
    if (rid === "lowg") return { g: GRAVITY * 0.62, vy: JUMP_VY * 0.85 };
    return { g: GRAVITY, vy: JUMP_VY };
  }
  /** Airtime from jump to landing on a pad `gap` px higher. */
  function airTime(gap, ph) {
    const v = -ph.vy;
    const disc = v * v - 2 * ph.g * gap;
    return (v + Math.sqrt(Math.max(0, disc))) / ph.g;
  }

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
    /** 0 = land / spread pose, 1 = jump pose. Visual only. */
    pose: 0,
    /** True only during a tap-jump, so a slide-off doesn't snap into the tuck. */
    jumping: false,
  };

  // 11 frames, frame 0 = land/spread, frame 10 = arms-up jump.
  // Sheets are 2x logical pixels; feet sit on y = frameH - foot.
  // VISUAL scales the drawing only. The 28×36 hit box stays the same.
  const POSE_N = 11;
  const VISUAL = 0.8;
  const CHAR_KEY = "leap-on-character";
  const CHARS = {
    guagua: {
      id: "guagua",
      name: "小瓜瓜",
      src: "assets/player-poses.png?v=3",
      fw: 210,
      fh: 222,
      foot: 4,
    },
    zhizhi: {
      id: "zhizhi",
      name: "小之之",
      src: "assets/zhizhi-poses.png?v=3",
      fw: 178,
      fh: 222,
      foot: 4,
    },
  };
  let characterId = "guagua";
  try {
    const saved = localStorage.getItem(CHAR_KEY);
    if (saved && CHARS[saved]) characterId = saved;
  } catch (_) {}
  const poseSheets = {};
  function sheetFor(id) {
    if (!poseSheets[id]) {
      const img = new Image();
      img.src = CHARS[id].src;
      poseSheets[id] = img;
    }
    return poseSheets[id];
  }
  sheetFor("guagua");
  sheetFor("zhizhi");
  function activeChar() {
    return CHARS[characterId];
  }

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
    if (mode === "random") return spawnNextRandom(prev);
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

  function spawnNextRandom(prev) {
    const floor = (prev.floor || 0) + 1;
    const level = levelOf(floor);
    const rid = ruleId(level);
    // base difficulty grows slowly with level; rules supply the twist
    const d = Math.min(14, 2 + level * 2);
    let gap = gapForScore(d);
    let w = platformWidthForScore(d);
    if (rid === "lowg") gap *= 1.12;
    if (rid === "narrow") w = Math.max(44, w * 0.62);
    if (rid === "ice") w = Math.max(w, 96) * 1.15;
    if (rid === "wind" || rid === "blink") w = Math.max(w, 84);
    const safe = maxSafeHorizOffset(prev.w, w);
    const budget = offsetBudget(d, safe);
    let drift = 0;
    if (rid === "wind") drift = windFor(level) * airTime(gap, physFor(rid));
    const half = w / 2;
    const lo = half + 12, hi = W - half - 12;
    let x = prev.x + drift + (Math.random() * 2 - 1) * budget;
    x = Math.max(lo, Math.min(hi, x));
    // fairness: target must stay within safe of (prev.x + drift)
    const center = prev.x + drift;
    if (Math.abs(x - center) > safe) {
      x = center + Math.sign(x - center) * safe;
      x = Math.max(lo, Math.min(hi, x));
    }
    let speed = 0, amp = 0;
    if (rid === "move") {
      speed = 90 + Math.min(70, level * 6) + Math.random() * 40;
      amp = 40 + Math.random() * 35;
    } else if (level >= 3 && rid !== "blink" && rid !== "crumble" && rid !== "ice" && Math.random() < 0.25) {
      speed = 50 + Math.random() * 30;
      amp = 25 + Math.random() * 15;
    }
    // Jumps are vertical and the player can't pick a standing spot, so every
    // pad sways enough to pass over any spot reachable on the previous pad.
    // (If prev also sways, the two drift into line on their own, so only
    // cover prev's centre then.)
    const reach = prev.w / 2 - PLAYER_W / 2 + (prev.amp || 0) * 0.5;
    const need = Math.abs(x - center) + reach - w / 2 + 12;
    if (speed === 0) speed = 38 + Math.random() * 22;
    amp = Math.min(80, Math.max(amp, need, 16));
    // randomised sway rate so two pads never phase-lock out of reach
    const rate = (rid === "crumble" || rid === "timer" ? 3.2 : 2.0) * (0.75 + Math.random() * 0.6);
    speed = Math.min(240, Math.max(speed, amp * rate));
    const p = makePlatform(x, prev.y - gap, w, 0);
    if (speed > 0) {
      const minB = half + amp + 8, maxB = W - half - amp - 8;
      if (minB > maxB) amp = Math.max(0, (W - w - 16) / 2);
      p.baseX = Math.max(Math.min(minB, maxB), Math.min(Math.max(minB, maxB), x));
      if (minB > maxB) p.baseX = W / 2;
      p.x = p.baseX; p.vx = speed * (Math.random() < 0.5 ? -1 : 1); p.amp = amp;
    }
    p.floor = floor;
    p.rule = rid;
    p.brittle = rid === "crumble";
    if (rid === "ice") p.ice = true;
    if (rid === "blink") { p.blink = true; p.blinkT = Math.random() * 1.8; }
    if (rid === "stars" && Math.random() < 0.75) {
      stars.push({ x: p.x, y: p.y - 70, plat: p, got: false, t: Math.random() * 6 });
    }
    return p;
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
    stars = stars.filter((st) => !st.got && st.y < cameraY + H + 200);
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
    levelRules = [];
    windDirs = {};
    stars = [];
    banner = null;
    levelTimer = 0;
    player.lastFloor = 0;
    player.slide = 0;
    player.scaleY = 1;
    player.landPulse = 0;
    player.vx = 0;
    player.vy = 0;
    player.onGround = true;
    player.platOffset = 0;
    player.pose = 0;
    player.jumping = false;

    const groundY = H - 100;
    const ground = makePlatform(W / 2, groundY, 160, 0);
    ground.floor = 0;
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
    bestEl.textContent = String(mode === "random" ? bestRandom : best);
    if (mode === "random") showBanner(0);
    lastTs = performance.now();
  }

  function showBanner(level) {
    const r = ruleFor(level);
    banner = { rule: r, level, t: 0 };
    if (r && r.id === "timer") levelTimer = 12;
    if (level > 0) beep(660, 0.09, "triangle", 0.05), setTimeout(() => beep(880, 0.12, "triangle", 0.05), 90);
  }

  function triggerGameOver(reason) {
    if (gameOver) return;
    gameOver = true;
    running = false;
    player.onGround = false;
    standingPlatform = null;
    beep(110, 0.22, "sawtooth", 0.06);

    let isRecord = false;
    if (mode === "random") {
      if (score > bestRandom) {
        bestRandom = score; isRecord = true;
        try { localStorage.setItem(BEST_KEY_RANDOM, String(bestRandom)); } catch (_) {}
      }
      bestEl.textContent = String(bestRandom);
    } else if (score > best) {
      best = score; isRecord = true;
      try {
        localStorage.setItem(BEST_KEY, String(best));
      } catch (_) {}
      bestEl.textContent = String(best);
    }
    const shownBest = mode === "random" ? bestRandom : best;

    overlayTitle.textContent = "结束了";
    overlaySub.textContent = "GAME OVER";
    const lvlTxt = mode === "random" ? "到达第 " + (levelOf(player.lastFloor + 1) + 1) + " 关 · " : "";
    overlayMsg.innerHTML =
      (reason === "timeout" ? "时间到！" : "") +
      (score > 0 && isRecord ? "新纪录！再来一把？" : reason === "timeout" ? "再来一把？" : "掉下去了。再来一把？");
    overlayScore.classList.remove("hidden");
    overlayScore.textContent = lvlTxt + "本局 " + score + " · 最高 " + shownBest;
    btnStart.textContent = "再来一把";
    setModeButtons(true);
    overlay.classList.remove("hidden");
  }

  function jump() {
    if (!running || gameOver || !player.onGround) return;
    player.onGround = false;
    const rid = activeRuleId();
    player.vy = physFor(rid).vy;
    player.vx = 0; // fixed arc — no horizontal aim (wind may push in random mode)
    player.slide = 0;
    standingPlatform = null;
    player.platOffset = 0;
    player.scaleY = 1.15;
    player.jumping = true;
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
    const prevLevel = levelOf(player.lastFloor + 1);
    player.lastFloor = plat.floor || 0;
    score += 1;
    if (plat.ice) player.slide = (Math.random() < 0.5 ? -1 : 1) * (85 + Math.random() * 40);
    if (mode === "random") {
      const nl = levelOf(player.lastFloor + 1);
      if (nl !== prevLevel) {
        score += 3; // level clear bonus
        showBanner(nl);
      }
    }
    scoreEl.textContent = String(score);
    player.landPulse = 1;
    player.scaleY = 0.72;
    player.jumping = false;
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
      plat.vanishAt = performance.now() + (plat.rule === "crumble" ? 1100 : 600);
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
      if (p.blink) {
        p.blinkT = (p.blinkT + dt) % 1.8;
        p.solid = p.blinkT < 1.15;
        if (!p.solid && standingPlatform && standingPlatform.id === p.id) {
          player.onGround = false;
          standingPlatform = null;
          player.platOffset = 0;
        }
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
    // Pose blend is visual only — collision stays on player.w / player.h.
    // Tap launches into the arms-up pose; landing eases back into the spread.
    const poseTarget = !player.onGround && player.jumping ? 1 : 0;
    const poseRate = poseTarget > player.pose ? 22 : 14;
    player.pose += (poseTarget - player.pose) * Math.min(1, dt * poseRate);

    if (player.onGround && standingPlatform) {
      if (player.slide) {
        player.platOffset += player.slide * dt;
        player.slide *= Math.exp(-2.2 * dt);
        if (Math.abs(player.slide) < 4) player.slide = 0;
        if (Math.abs(player.platOffset) > standingPlatform.w / 2 + 2) {
          // slid off the edge
          player.onGround = false;
          standingPlatform = null;
          player.vx = player.slide * 0.5;
          player.slide = 0;
        }
      }
    }
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
      const rid = activeRuleId();
      player.vy += physFor(rid).g * dt;
      // no player steering; wind (random mode) is the only push
      const wind = rid === "wind" ? windFor(levelOf((player.lastFloor || 0) + 1)) : 0;
      player.x += (player.vx + wind) * dt;
      player.x = Math.max(player.w / 2, Math.min(W - player.w / 2, player.x));
      player.y += player.vy * dt;

      if (player.vy > 0) {
        const footY = player.y + player.h / 2;
        const prevFoot = footY - player.vy * dt;
        for (const p of platforms) {
          if (p.gone || (p.blink && !p.solid)) continue;
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
    if (mode === "random") {
      for (const st of stars) {
        st.t += dt;
        if (!st.got && Math.abs(st.x - player.x) < 26 && Math.abs(st.y - player.y) < 30) {
          st.got = true;
          score += 2;
          scoreEl.textContent = String(score);
          beep(1040, 0.07, "sine", 0.05);
          for (let i = 0; i < 10; i++) particles.push({ x: st.x, y: st.y, vx: (Math.random() - 0.5) * 220, vy: (Math.random() - 0.5) * 220, life: 0.4, color: "#ffd84a" });
        }
      }
      if (banner) banner.t += dt;
      const r = ruleFor(levelOf((player.lastFloor || 0) + 1));
      if (r && r.id === "timer" && banner && banner.rule === r) {
        levelTimer -= dt;
        if (levelTimer <= 0) triggerGameOver("timeout");
      }
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
    if (p.blink) {
      const warn = p.solid && p.blinkT > 0.85;
      ctx.globalAlpha = p.solid ? (warn ? 0.45 + 0.4 * Math.abs(Math.sin(p.blinkT * 30)) : 1) : 0.14;
      ctx.fillStyle = "#b8b860";
      roundRect(ctx, x, y, p.w, p.h, 6); ctx.fill();
      ctx.fillStyle = "#f0f0a0";
      roundRect(ctx, x, y, p.w, 5, 4); ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }
    if (p.ice) {
      ctx.fillStyle = "#5fa8c8";
      roundRect(ctx, x, y, p.w, p.h, 6); ctx.fill();
      ctx.fillStyle = "#dff8ff";
      roundRect(ctx, x, y, p.w, 5, 4); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillRect(x + p.w * 0.2, y + 1, 10, 2); ctx.fillRect(x + p.w * 0.65, y + 1, 6, 2);
      return;
    }

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
    const footY = s.y + player.h / 2;
    const spread = 1 - Math.max(0, Math.min(1, player.pose));

    if (player.onGround) {
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(s.x, footY + 3, 12 + spread * 22, 4.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const ch = activeChar();
    const poseSheet = sheetFor(ch.id);
    const ready = poseSheet.complete && poseSheet.naturalWidth > 0;
    if (!ready) {
      const hw = player.w / 2;
      const hh = (player.h / 2) * player.scaleY;
      const top = s.y - hh;
      ctx.fillStyle = "#e8f0ff";
      roundRect(ctx, s.x - hw, top, player.w, hh * 2, 8);
      ctx.fill();
      ctx.fillStyle = "#4aa3e8";
      roundRect(ctx, s.x - hw + 4, top + 6, player.w - 8, 8, 4);
      ctx.fill();
      return;
    }

    const pose = Math.max(0, Math.min(1, player.pose));
    // Smoothstep rushes the imperfect middle frames and settles on the two photos.
    const eased = pose * pose * (3 - 2 * pose);
    const frame = Math.round(eased * (POSE_N - 1));
    // Squash/stretch around the feet. Width eases the other way so the volume holds.
    const sy = 0.5 * VISUAL * player.scaleY;
    const sx = (0.5 * VISUAL) / Math.pow(Math.max(0.55, player.scaleY), 0.35);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.translate(s.x, footY);
    ctx.scale(sx, sy);
    ctx.drawImage(
      poseSheet,
      frame * ch.fw, 0, ch.fw, ch.fh,
      -ch.fw / 2, -(ch.fh - ch.foot), ch.fw, ch.fh
    );
    ctx.restore();
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

  function drawStars() {
    for (const st of stars) {
      if (st.got) continue;
      const s = worldToScreen(st.x, st.y + Math.sin(st.t * 4) * 4);
      if (s.y < -20 || s.y > H + 20) continue;
      ctx.fillStyle = "#ffd84a";
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 5 : 12, a = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(s.x + Math.cos(a) * r, s.y + Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
    }
  }

  function drawWind() {
    const lvl = levelOf((player.lastFloor || 0) + 1);
    if (ruleId(lvl) !== "wind") return;
    const dir = Math.sign(windFor(lvl));
    ctx.strokeStyle = "rgba(140,240,180,0.25)";
    ctx.lineWidth = 2;
    const t = performance.now() / 1000;
    for (let i = 0; i < 9; i++) {
      const yy = (i * 83 + 20) % H;
      let xx = ((i * 131 + t * 220 * dir) % (W + 80) + W + 80) % (W + 80) - 40;
      ctx.beginPath(); ctx.moveTo(xx, yy); ctx.lineTo(xx + 28 * dir, yy); ctx.stroke();
    }
  }

  function drawRuleHud() {
    if (mode !== "random" || !running) return;
    const lvl = levelOf((player.lastFloor || 0) + 1);
    const r = ruleFor(lvl);
    ctx.textAlign = "left";
    ctx.font = "bold 13px system-ui,sans-serif";
    ctx.fillStyle = r.color;
    const floorIn = ((player.lastFloor || 0) % FLOORS_PER_LEVEL);
    ctx.fillText("第" + (lvl + 1) + "关 · " + r.name + "  " + floorIn + "/" + FLOORS_PER_LEVEL, 10, 20);
    if (r.id === "timer") {
      ctx.textAlign = "right";
      ctx.font = "bold 18px system-ui,sans-serif";
      ctx.fillStyle = levelTimer < 4 ? "#ff5a5a" : "#ffd0d0";
      ctx.fillText(Math.max(0, levelTimer).toFixed(1) + "s", W - 10, 22);
    }
    if (banner && banner.t < 2.2) {
      const t = banner.t;
      const a = t < 0.2 ? t / 0.2 : t > 1.8 ? Math.max(0, (2.2 - t) / 0.4) : 1;
      const sc = t < 0.2 ? 0.8 + t : 1;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(W / 2, H * 0.3);
      ctx.scale(sc, sc);
      ctx.fillStyle = "rgba(8,14,28,0.82)";
      roundRect(ctx, -165, -46, 330, 92, 14); ctx.fill();
      ctx.strokeStyle = r.color; ctx.lineWidth = 2;
      roundRect(ctx, -165, -46, 330, 92, 14); ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillStyle = "#8aa0c8";
      ctx.font = "12px system-ui,sans-serif";
      ctx.fillText("第 " + (banner.level + 1) + " 关", 0, -24);
      ctx.fillStyle = r.color;
      ctx.font = "bold 28px system-ui,sans-serif";
      ctx.fillText(r.name, 0, 8);
      ctx.fillStyle = "#e8eefc";
      ctx.font = "14px system-ui,sans-serif";
      ctx.fillText(r.desc, 0, 32);
      ctx.restore();
    }
  }

  function drawHint() {
    if (!running || score > 0 || !player.onGround) return;
    ctx.fillStyle = "rgba(168,192,240,0.55)";
    ctx.font = "14px system-ui,sans-serif";
    ctx.textAlign = "center";
    const s = worldToScreen(player.x, player.y);
    ctx.fillText("点按跳跃", s.x, s.y - 96);
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
    drawWind();
    for (const p of platforms) drawPlatform(p);
    drawStars();
    drawParticles();
    drawPlayer();
    drawHint();
    drawRuleHud();
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
      const onCard = e.target && e.target.closest && e.target.closest(".char-card");
      if (onCard) return;
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

  const btnClassic = document.getElementById("btn-classic");
  function setModeButtons(show) {
    if (!btnClassic) return;
    btnClassic.classList.toggle("hidden", !show);
    btnClassic.textContent = mode === "random" ? "换经典模式" : "换随机玩法";
  }
  function startMode(m) {
    mode = m;
    resetGame();
  }
  if (btnClassic) {
    btnClassic.addEventListener("click", function (e) { e.stopPropagation(); startMode(mode === "random" ? "classic" : "random"); });
    btnClassic.addEventListener("touchend", function (e) { e.preventDefault(); e.stopPropagation(); startMode(mode === "random" ? "classic" : "random"); }, { passive: false });
  }

  btnStart.addEventListener("click", function (e) {
    e.stopPropagation();
    startMode(mode);
  });
  btnStart.addEventListener(
    "touchend",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      startMode(mode);
    },
    { passive: false }
  );

  overlayTitle.textContent = "跃·不停";
  overlaySub.textContent = "Leap On";
  overlayMsg.innerHTML =
    "点按跳跃，落稳平台。<br/>随机玩法：每 10 层一关，每关规则随机。";
  overlayScore.classList.add("hidden");
  btnStart.textContent = "随机玩法";
  overlay.classList.remove("hidden");

  function showIdleScene() {
    score = 0;
    platforms = [];
    stars = [];
    const ground = makePlatform(W / 2, H - 100, 160, 0);
    ground.floor = 0;
    ground.brittle = false;
    ground.vx = 0;
    ground.amp = 0;
    platforms.push(ground);
    player.x = ground.x;
    player.y = ground.y - player.h / 2;
    player.onGround = true;
    player.pose = 0;
    player.jumping = false;
    standingPlatform = ground;
    climbY = ground.y;
    cameraY = 0;
  }
  function selectCharacter(id) {
    if (!CHARS[id]) return;
    characterId = id;
    try { localStorage.setItem(CHAR_KEY, id); } catch (_) {}
    document.querySelectorAll(".char-card").forEach(function (btn) {
      const on = btn.dataset.char === id;
      btn.classList.toggle("selected", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
    if (!running && !gameOver) showIdleScene();
  }
  document.querySelectorAll(".char-card").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      selectCharacter(btn.dataset.char);
    });
    btn.addEventListener("touchend", function (e) {
      e.preventDefault();
      e.stopPropagation();
      selectCharacter(btn.dataset.char);
    }, { passive: false });
  });
  selectCharacter(characterId);
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
    startMode,
    selectCharacter,
    RULES,
    getRules: () => levelRules.map((r) => r.id),
    getState: function () {
      return {
        mode,
        bestRandom,
        level: levelOf((player.lastFloor || 0) + 1),
        rule: activeRuleId(),
        wind: windFor(levelOf((player.lastFloor || 0) + 1)),
        standing: standingPlatform,
        platforms,
        playerX: player.x,
        score,
        best,
        running,
        gameOver,
        onGround: player.onGround,
        platformCount: platforms.length,
        playerY: player.y,
        climbY,
        playerVx: player.vx,
        character: characterId,
        pose: player.pose,
        jumping: player.jumping,
      };
    },
  };
})();
