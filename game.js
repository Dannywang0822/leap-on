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
  /** Cartoon body and hit box grow together. 28×36 → 35×45. */
  const PLAYER_SCALE = 1.25;
  const PLAYER_W = 28 * PLAYER_SCALE;
  const PLAYER_H = 36 * PLAYER_SCALE;
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
  /** Optional test seed: rule ids applied at the start of a run, before spawn. */
  let ruleSeed = null;
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
    /** Airborne from a spring-boosted takeoff. Landing only accepts the next floor. */
    springJump: false,
  };

  // One pixel density for every pose. 512 canvases draw at ~92px, 1024 at ~184px.
  // Pivot is the sole center, on the bottom-center of the 35×45 hit box, so the
  // body grows up and out from the feet and does not sink into the pad.
  const SPRITE_SCALE = (36 / 451) * 1.8 * PLAYER_SCALE;
  // Opaque extents from the sole pivot, in source pixels. Land is the widest
  // body (arms and feet); jump hands are the highest normal pose. Crown covers
  // the tallest drawn pose so a spring hop cannot leave the top of the view.
  const LAND_HALF_SRC = 213;
  const JUMP_HALF_SRC = 135;
  const JUMP_TOP_SRC = 451;
  const CROWN_SRC = 478;
  const SCREEN_PAD = 4;
  const LAND_HALF = LAND_HALF_SRC * SPRITE_SCALE;
  const JUMP_HALF = JUMP_HALF_SRC * SPRITE_SCALE;
  const JUMP_TOP = JUMP_TOP_SRC * SPRITE_SCALE;
  const CROWN = CROWN_SRC * SPRITE_SCALE;
  // A pad's edge must leave the land pose on screen when the body stands on
  // the inner lip: edge + playerW/2 − landHalf >= SCREEN_PAD.
  const EDGE_INSET = Math.ceil(LAND_HALF + SCREEN_PAD - PLAYER_W / 2);
  const CHAR_KEY = "leap-on-character";
  const CHARS = {
    guagua: {
      id: "guagua",
      name: "小瓜瓜",
      jumpSrc: "assets/guagua_jump.png?v=7",
      landSrc: "assets/guagua_land.png?v=7",
      rocketSrc: "assets/guagua_rocket_ride.png?v=7",
      springSrc: "assets/guagua_spring_burst.png?v=7",
      rocketPivotX: 479,
      rocketPivotY: 708,
      springPivotX: 511,
      springPivotY: 684,
    },
    zhizhi: {
      id: "zhizhi",
      name: "小之之",
      jumpSrc: "assets/zhizhi_jump.png?v=7",
      landSrc: "assets/zhizhi_land.png?v=7",
      rocketSrc: "assets/zhizhi_rocket_ride.png?v=7",
      springSrc: "assets/zhizhi_spring_burst.png?v=7",
      rocketPivotX: 562,
      rocketPivotY: 682,
      springPivotX: 514,
      springPivotY: 676,
    },
  };
  let characterId = "guagua";
  try {
    const saved = localStorage.getItem(CHAR_KEY);
    if (saved && CHARS[saved]) characterId = saved;
  } catch (_) {}
  function loadFrame(src) {
    const img = new Image();
    img.src = src;
    return img;
  }
  for (const id in CHARS) {
    CHARS[id].jump = loadFrame(CHARS[id].jumpSrc);
    CHARS[id].land = loadFrame(CHARS[id].landSrc);
    CHARS[id].rocket = loadFrame(CHARS[id].rocketSrc);
    CHARS[id].spring = loadFrame(CHARS[id].springSrc);
  }
  function activeChar() {
    return CHARS[characterId];
  }
  const ITEM_DRAW = 24 * 1.8;
  const ITEM_LIFT = 28 * 1.8;
  const ITEM_BURST = 0.34;
  const itemImages = {};
  function itemImage(kind) {
    if (!itemImages[kind]) {
      const img = new Image();
      img.src = "assets/items/item_" + kind + ".png?v=7";
      itemImages[kind] = img;
    }
    return itemImages[kind];
  }
  itemImage("life");
  itemImage("rocket");
  itemImage("spring");

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

  // --- pickups: life / rocket / spring. Same rules for both characters. ---
  const ITEM_MIN = { life: 12, rocket: 10, spring: 6 };
  const ITEM_GAP = { life: 14, rocket: 16, spring: 8 };
  const ITEM_CHANCE = { life: 0.12, rocket: 0.10, spring: 0.18 };
  const ITEM_LABEL = { life: "生命", rocket: "火箭", spring: "弹力" };
  const SPRING_MUL = 1.18;
  const ROCKET_FLOORS = 10;
  const ROCKET_DUR = 0.85;
  const REVIVE_GRACE = 0.6;
  const GHOST_LIFE = 1.4;
  const PICKUP_BANNER = 0.8;

  let extraLives = 0;
  let springJumps = 0;
  let fallGrace = 0;
  let punchT = 0;
  let rocketRide = null;
  let pickupBanner = null;
  let itemBursts = [];
  let lastSafe = null;
  let needRevive = false;
  let itemFloors = new Set();
  let lastItemFloor = { life: -9999, rocket: -9999, spring: -9999 };

  const itemHud = document.getElementById("item-hud");
  const hudLives = document.getElementById("hud-lives");
  const hudSpring = document.getElementById("hud-spring");

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
    // Keep the whole oscillation inside the screen, far enough that the
    // land pose is not cropped when the body stands on the inner lip.
    const minBase = half + amp + EDGE_INSET;
    const maxBase = W - half - amp - EDGE_INSET;
    if (minBase > maxBase) {
      amp = Math.max(0, (W - w - 2 * EDGE_INSET) / 2);
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
    x = Math.max(half + EDGE_INSET, Math.min(W - half - EDGE_INSET, x));
    const dx = x - prev.x;
    if (Math.abs(dx) > safe) {
      x = prev.x + Math.sign(dx || 1) * safe;
      x = Math.max(half + EDGE_INSET, Math.min(W - half - EDGE_INSET, x));
    }
    // Spring / rocket never widen this gap or the offset clamp above.
    const p = makePlatform(x, prev.y - gap, w, scoreHint);
    p.floor = (prev.floor || 0) + 1;
    tryAttachItem(p);
    return p;
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
    const lo = half + EDGE_INSET, hi = W - half - EDGE_INSET;
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
      const minB = half + amp + EDGE_INSET, maxB = W - half - amp - EDGE_INSET;
      if (minB > maxB) amp = Math.max(0, (W - w - 2 * EDGE_INSET) / 2);
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
    tryAttachItem(p);
    return p;
  }

  function clearRunBuffs() {
    extraLives = 0;
    springJumps = 0;
    fallGrace = 0;
    rocketRide = null;
    pickupBanner = null;
    itemBursts = [];
    lastSafe = null;
    needRevive = false;
    itemFloors = new Set();
    lastItemFloor = { life: -9999, rocket: -9999, spring: -9999 };
    player.springJump = false;
    punchT = 0;
  }

  function itemHudImg(kind, dim) {
    return '<img src="assets/items/item_' + kind + '.png?v=7" width="20" height="20" alt=""' + (dim ? ' class="dim"' : "") + ">";
  }

  function syncItemHud() {
    if (!itemHud) return;
    const show = running && !gameOver;
    itemHud.classList.toggle("hidden", !show);
    if (!show || !hudLives || !hudSpring) return;
    hudLives.innerHTML = itemHudImg("life", extraLives < 1) + itemHudImg("life", extraLives < 2);
    hudLives.setAttribute("aria-label", "生命 " + extraLives);
    hudSpring.innerHTML = itemHudImg("spring", springJumps <= 0) + "<b>" + springJumps + "</b>";
    hudSpring.classList.toggle("off", springJumps <= 0);
    hudSpring.setAttribute("aria-label", "弹力 " + springJumps);
  }

  function rememberSafe(plat) {
    if (!plat) return;
    lastSafe = {
      id: plat.id,
      x: plat.baseX,
      y: plat.y,
      w: plat.w,
      floor: plat.floor || 0,
    };
  }

  function lifeChance() {
    if (mode === "classic" && score >= 15) return 0.18;
    return ITEM_CHANCE.life;
  }

  /** Current level and the 10-floor flight path. Classic has no timed levels. */
  function rocketPathTimed(floor) {
    if (mode !== "random") return false;
    const a = levelOf(floor);
    const b = levelOf(floor + ROCKET_FLOORS);
    for (let L = a; L <= b; L++) {
      if (ruleId(L) === "timer") return true;
    }
    return false;
  }

  function itemEligible(kind, floor) {
    if (floor < ITEM_MIN[kind]) return false;
    if (floor - lastItemFloor[kind] < ITEM_GAP[kind]) return false;
    if (kind === "life" && extraLives >= 2) return false;
    if (kind === "rocket" && rocketPathTimed(floor)) return false;
    return true;
  }

  function tryAttachItem(p) {
    if (!p || p.ghost || p.item) return;
    const floor = p.floor || 0;
    if (floor <= 5) return;
    if (itemFloors.has(floor - 1)) return;
    const last = player.lastFloor || 0;
    for (const q of platforms) {
      if (q === p || q.gone || !q.item || q.item.got) continue;
      const qf = q.floor || 0;
      if (qf <= last) continue;
      if (Math.abs(qf - floor) < 5) return;
    }
    const kinds = ["life", "rocket", "spring"];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = kinds[i];
      kinds[i] = kinds[j];
      kinds[j] = tmp;
    }
    for (const kind of kinds) {
      if (!itemEligible(kind, floor)) continue;
      const chance = kind === "life" ? lifeChance() : ITEM_CHANCE[kind];
      if (Math.random() < chance) {
        p.item = { kind: kind, got: false };
        itemFloors.add(floor);
        lastItemFloor[kind] = floor;
        return;
      }
    }
  }

  function platformAtFloor(floor) {
    for (const p of platforms) {
      if (!p.gone && !p.ghost && (p.floor || 0) === floor) return p;
    }
    return null;
  }

  function highestFloorPlatform() {
    let top = null;
    for (const p of platforms) {
      if (p.gone || p.ghost) continue;
      if (!top || (p.floor || 0) > (top.floor || 0)) top = p;
    }
    return top;
  }

  function dropPlatformsAbove(floor) {
    const drop = new Set();
    const keep = [];
    for (const p of platforms) {
      if (!p.ghost && (p.floor || 0) > floor) drop.add(p);
      else keep.push(p);
    }
    platforms = keep;
    if (drop.size) stars = stars.filter((st) => !st.plat || !drop.has(st.plat));
  }

  function alignPlatformBase(p, launchX) {
    const half = p.w / 2;
    const amp = p.amp || 0;
    const minB = half + amp + EDGE_INSET;
    const maxB = W - half - amp - EDGE_INSET;
    let base = launchX;
    if (minB <= maxB) base = Math.max(minB, Math.min(maxB, base));
    else base = W / 2;
    const prevX = p.x;
    p.baseX = base;
    p.phase = 0;
    p.x = base;
    const dx = p.x - prevX;
    if (dx !== 0) {
      for (const st of stars) if (st.plat === p) st.x += dx;
    }
  }

  function beginRocket(fromPlat) {
    const startFloor = fromPlat.floor || 0;
    const destFloor = startFloor + ROCKET_FLOORS;
    let guard = 0;
    while (!platformAtFloor(destFloor) && guard++ < 40) {
      const top = highestFloorPlatform();
      if (!top) return false;
      platforms.push(spawnNext(top, score));
    }
    const dest = platformAtFloor(destFloor);
    if (!dest) return false;
    dropPlatformsAbove(destFloor);
    alignPlatformBase(dest, player.x);
    rocketRide = {
      t: 0,
      dur: ROCKET_DUR,
      dest: dest,
      startFloor: startFloor,
      destFloor: destFloor,
      y0: player.y,
    };
    player.onGround = false;
    standingPlatform = null;
    player.platOffset = 0;
    player.vx = 0;
    player.vy = 0;
    player.slide = 0;
    player.jumping = true;
    player.springJump = false;
    beep(740, 0.09, "square", 0.05);
    return true;
  }

  function grantStar(st) {
    if (!st || st.got) return;
    st.got = true;
    score += 2;
    scoreEl.textContent = String(score);
    beep(1040, 0.07, "sine", 0.05);
    for (let i = 0; i < 10; i++) {
      particles.push({
        x: st.x,
        y: st.y,
        vx: (Math.random() - 0.5) * 220,
        vy: (Math.random() - 0.5) * 220,
        life: 0.4,
        color: "#ffd84a",
      });
    }
  }

  function finishRocket() {
    const ride = rocketRide;
    if (!ride) return;
    rocketRide = null;
    const dest = ride.dest;
    if (dest.blink) {
      dest.blinkT = 0;
      dest.solid = true;
    }
    player.x = dest.x;
    player.y = dest.y - player.h / 2;
    player.vx = 0;
    player.vy = 0;
    player.slide = 0;
    player.onGround = true;
    player.jumping = false;
    player.springJump = false;
    player.platOffset = 0;
    standingPlatform = dest;
    climbY = dest.y;
    const prevUpcoming = levelOf(ride.startFloor + 1);
    player.lastFloor = dest.floor || ride.destFloor;
    score += ride.destFloor - ride.startFloor;
    if (mode === "random") {
      const nl = levelOf(player.lastFloor + 1);
      if (nl !== prevUpcoming) {
        score += 3;
        showBanner(nl);
      }
    }
    scoreEl.textContent = String(score);
    rememberSafe(dest);
    if (dest.ice) player.slide = (Math.random() < 0.5 ? -1 : 1) * (85 + Math.random() * 40);
    if (dest.brittle && dest.vanishAt == null) {
      dest.vanishAt = performance.now() + (dest.rule === "crumble" ? 1100 : 600);
    }
    player.landPulse = 1;
    player.scaleY = 0.72;
    beep(880, 0.1, "triangle", 0.06);
    collectItem(dest);
    syncItemHud();
  }

  function updateRocket(dt) {
    const ride = rocketRide;
    if (!ride) return;
    ride.t += dt;
    const u = Math.min(1, ride.t / ride.dur);
    const eased = 1 - (1 - u) * (1 - u);
    const dest = ride.dest;
    const y1 = dest.y - player.h / 2;
    player.x = dest.x;
    player.y = ride.y0 + (y1 - ride.y0) * eased;
    player.vx = 0;
    player.vy = 0;
    if (Math.random() < 0.7) {
      particles.push({
        x: player.x + (Math.random() - 0.5) * 8,
        y: player.y + player.h * 0.4,
        vx: (Math.random() - 0.5) * 30,
        vy: 70 + Math.random() * 50,
        life: 0.22,
        color: Math.random() < 0.5 ? "#ffd84a" : "#ff7a3c",
      });
    }
    if (mode === "random") {
      for (const st of stars) {
        st.t += dt;
        if (st.got || !st.plat) continue;
        const f = st.plat.floor || 0;
        if (f <= ride.startFloor || f > ride.destFloor) continue;
        if (Math.abs(st.x - player.x) <= PLAYER_W) grantStar(st);
      }
      if (banner) banner.t += dt;
    }
    if (u >= 1) finishRocket();
  }

  function showPickup(kind, x, y) {
    pickupBanner = { kind: kind, t: 0 };
    itemBursts.push({ kind: kind, x: x, y: y, t: 0, dur: ITEM_BURST });
    const freq = kind === "life" ? 680 : kind === "rocket" ? 760 : 520;
    beep(freq, 0.09, "triangle", 0.055);
    for (let i = 0; i < 8; i++) {
      particles.push({
        x: player.x,
        y: player.y,
        vx: (Math.random() - 0.5) * 180,
        vy: -40 - Math.random() * 120,
        life: 0.35,
        color: kind === "life" ? "#ff4d6d" : kind === "rocket" ? "#ffb15a" : "#d6ff6a",
      });
    }
  }

  function collectItem(plat) {
    if (rocketRide) return;
    if (!plat || !plat.item || plat.item.got) return;
    if (plat.blink && plat.solid === false) return;
    const kind = plat.item.kind;
    plat.item.got = true;
    if (kind === "life") extraLives = Math.min(2, extraLives + 1);
    else if (kind === "spring") springJumps = 3;
    else if (kind === "rocket") {
      const started = beginRocket(plat);
      if (!started) {
        plat.item.got = false;
        return;
      }
    }
    showPickup(kind, plat.x, plat.y - ITEM_LIFT);
    syncItemHud();
  }

  function makeGhostPlatform(safe) {
    const w = Math.max(safe.w || 80, 80);
    const half = w / 2;
    const x = Math.max(half + EDGE_INSET, Math.min(W - half - EDGE_INSET, safe.x));
    const p = makePlatform(x, safe.y, w, 0);
    p.x = x;
    p.baseX = x;
    p.vx = 0;
    p.amp = 0;
    p.brittle = false;
    p.ice = false;
    p.blink = false;
    p.ghost = true;
    p.item = null;
    p.floor = safe.floor;
    p.rule = null;
    p.vanishAt = performance.now() + GHOST_LIFE * 1000;
    return p;
  }

  function placeOnPlatform(plat) {
    player.onGround = true;
    player.vx = 0;
    player.vy = 0;
    player.slide = 0;
    player.jumping = false;
    player.springJump = false;
    player.x = plat.x;
    player.y = plat.y - player.h / 2;
    player.platOffset = 0;
    standingPlatform = plat;
    climbY = plat.y;
    rememberSafe(plat);
  }

  function revive() {
    if (gameOver) return;
    extraLives = Math.max(0, extraLives - 1);
    springJumps = 0;
    player.springJump = false;
    rocketRide = null;
    fallGrace = REVIVE_GRACE;
    const safe = lastSafe || {
      id: -1,
      x: W / 2,
      y: H - 100,
      w: 160,
      floor: player.lastFloor || 0,
    };
    let plat = null;
    for (const p of platforms) {
      if (p.id === safe.id && !p.gone) { plat = p; break; }
    }
    const hidden = plat && plat.blink && plat.solid === false;
    if (!plat || hidden) {
      plat = makeGhostPlatform(safe);
      platforms.push(plat);
    }
    placeOnPlatform(plat);
    cameraY = player.y - H * 0.58;
    if (cameraY > 0) cameraY = 0;
    syncItemHud();
    beep(440, 0.1, "triangle", 0.06);
  }

  /** "revive" spends a life, "absorb" ignores the hazard, "die" is the caller's old fail path. */
  function footingFate() {
    if (rocketRide || fallGrace > 0) return "absorb";
    if (extraLives > 0) return "revive";
    return "die";
  }

  function updateCamera(dt) {
    const targetCam = player.y - H * 0.58;
    cameraY += (targetCam - cameraY) * Math.min(1, CAMERA_LERP * dt);
    if (cameraY > 0) cameraY *= 0.9;
    // screenY = worldY - cameraY. Keep the tallest crown inside the view.
    const crown = player.y + player.h / 2 - CROWN;
    const maxCam = crown - SCREEN_PAD;
    if (cameraY > maxCam) cameraY = maxCam;
  }

  /** Airborne body stays fully on screen. Land pose is wider but only stands on a pad. */
  function clampAirX(x) {
    const limit = Math.max(player.w / 2, JUMP_HALF + SCREEN_PAD);
    return Math.max(limit, Math.min(W - limit, x));
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
    if (ruleSeed && ruleSeed.length) {
      for (let i = 0; i < ruleSeed.length; i++) {
        levelRules[i] = RULES.find(function (r) { return r.id === ruleSeed[i]; }) || WARMUP;
      }
    }
    windDirs = {};
    stars = [];
    banner = null;
    levelTimer = 0;
    clearRunBuffs();
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
    player.springJump = false;

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
    rememberSafe(ground);

    let last = ground;
    for (let i = 0; i < 6; i++) {
      last = spawnNext(last, i);
      platforms.push(last);
    }

    overlay.classList.add("hidden");
    bestEl.textContent = String(mode === "random" ? bestRandom : best);
    if (mode === "random") showBanner(0);
    syncItemHud();
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
    clearRunBuffs();
    syncItemHud();
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
    if (!running || gameOver || !player.onGround || rocketRide) return;
    player.onGround = false;
    const rid = activeRuleId();
    const ph = physFor(rid);
    if (springJumps > 0) {
      springJumps -= 1;
      player.springJump = true;
      player.vy = ph.vy * SPRING_MUL;
      punchT = 0.0001;
    } else {
      player.springJump = false;
      player.vy = ph.vy;
    }
    player.vx = 0; // fixed arc — no horizontal aim (wind may push in random mode)
    player.slide = 0;
    standingPlatform = null;
    player.platOffset = 0;
    player.scaleY = 1.15;
    player.jumping = true;
    syncItemHud();
    beep(520, 0.06, "square", 0.045);
  }

  function landOn(plat) {
    // Only land on a platform higher than last stand (smaller y). Else fall = game over.
    if (!(plat.y < climbY - 2)) {
      const fate = footingFate();
      if (fate === "revive") revive();
      else if (fate === "die") triggerGameOver();
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
    player.springJump = false;
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
    rememberSafe(plat);
    collectItem(plat);
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
          const fate = footingFate();
          if (fate === "revive") needRevive = true;
          else {
            player.onGround = false;
            standingPlatform = null;
            player.platOffset = 0;
          }
        }
      }
      if (p.vanishAt != null && now >= p.vanishAt) {
        p.gone = true;
        if (standingPlatform && standingPlatform.id === p.id) {
          const fate = footingFate();
          if (fate === "revive") needRevive = true;
          else {
            player.onGround = false;
            standingPlatform = null;
            player.platOffset = 0;
          }
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
    if (needRevive) {
      needRevive = false;
      revive();
    }
    platforms = platforms.filter((p) => !p.gone);
  }

  function updateJuice(dt) {
    if (punchT > 0) {
      punchT += dt;
      if (punchT > 0.24) punchT = 0;
    }
    if (itemBursts.length) {
      for (const b of itemBursts) b.t += dt;
      itemBursts = itemBursts.filter((b) => b.t < b.dur);
    }
  }

  function updatePlayer(dt) {
    updateJuice(dt);
    if (pickupBanner) {
      pickupBanner.t += dt;
      if (pickupBanner.t >= PICKUP_BANNER) pickupBanner = null;
    }
    if (fallGrace > 0) fallGrace = Math.max(0, fallGrace - dt);
    if (rocketRide) {
      updateRocket(dt);
      updateCamera(dt);
      player.pose += (1 - player.pose) * Math.min(1, dt * 22);
      player.scaleY += (1 - player.scaleY) * Math.min(1, dt * 12);
      return;
    }
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
          const fate = footingFate();
          const slideVx = player.slide * 0.5;
          player.slide = 0;
          if (fate === "revive") {
            revive();
          } else {
            player.onGround = false;
            standingPlatform = null;
            player.vx = slideVx;
          }
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
      const ph = physFor(rid);
      let g = ph.g;
      // Low-g spring: level phys first, then the 1.18 takeoff. Gravity stays,
      // but never drops below half of normal gravity.
      if (player.springJump && rid === "lowg") g = Math.max(g, GRAVITY * 0.5);
      player.vy += g * dt;
      // no player steering; wind (random mode) is the only push
      const wind = rid === "wind" ? windFor(levelOf((player.lastFloor || 0) + 1)) : 0;
      player.x += (player.vx + wind) * dt;
      player.x = clampAirX(player.x);
      player.y += player.vy * dt;

      if (player.vy > 0) {
        const footY = player.y + player.h / 2;
        const prevFoot = footY - player.vy * dt;
        for (const p of platforms) {
          if (p.gone || (p.blink && !p.solid)) continue;
          // A higher arc still only sticks to the next floor — never skip one.
          if (player.springJump && (p.floor || 0) !== (player.lastFloor || 0) + 1) continue;
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

    if (gameOver) return;
    if (rocketRide) {
      updateCamera(dt);
      return;
    }

    updateCamera(dt);

    if (player.y - cameraY > H + 40) {
      const fate = footingFate();
      if (fate === "revive") revive();
      else if (fate === "die") triggerGameOver();
    }
    if (gameOver) return;
    if (mode === "random") {
      for (const st of stars) {
        st.t += dt;
        if (!st.got && Math.abs(st.x - player.x) < 26 && Math.abs(st.y - player.y) < 30) {
          grantStar(st);
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
    if (p.ghost) {
      const life = p.vanishAt ? Math.max(0, (p.vanishAt - performance.now()) / (GHOST_LIFE * 1000)) : 1;
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.45 * life;
      ctx.fillStyle = "#d7e6ff";
      roundRect(ctx, x, y, p.w, p.h, 6);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      roundRect(ctx, x, y, p.w, p.h, 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }
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

  function frameReady(img) {
    return !!(img && img.complete && img.naturalWidth > 0);
  }

  /** Draw a sprite so its pivot sits on the hit-box sole. Scale is shared. */
  function drawAnchored(img, pivotX, pivotY, srcSize, footX, footY) {
    if (!frameReady(img)) {
      const hw = player.w / 2;
      ctx.fillStyle = "#e8f0ff";
      roundRect(ctx, footX - hw, footY - player.h, player.w, player.h, 8);
      ctx.fill();
      ctx.fillStyle = "#4aa3e8";
      roundRect(ctx, footX - hw + 4, footY - player.h + 6, player.w - 8, 8, 4);
      ctx.fill();
      return;
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.translate(footX, footY);
    ctx.scale(SPRITE_SCALE, SPRITE_SCALE);
    ctx.drawImage(img, -pivotX, -pivotY, srcSize, srcSize);
    ctx.restore();
  }

  function punchOffset() {
    if (punchT <= 0) return 0;
    const u = Math.min(1, punchT / 0.24);
    return Math.sin(u * Math.PI) * -8;
  }

  function drawPlayer() {
    const s = worldToScreen(player.x, player.y);
    const footY = s.y + player.h / 2;
    const ch = activeChar();
    const riding = !!rocketRide;
    const springAir = player.springJump && !player.onGround;

    if (player.onGround && !riding) {
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(s.x, footY + 2, 10 * PLAYER_SCALE, 3.2 * PLAYER_SCALE, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (riding) {
      drawAnchored(ch.rocket, ch.rocketPivotX, ch.rocketPivotY, 1024, s.x, footY);
    } else if (springAir) {
      drawAnchored(ch.spring, ch.springPivotX, ch.springPivotY, 1024, s.x, footY);
    } else {
      drawAnchored(airborneFrame(ch), 256, 481, 512, s.x, footY);
    }
  }

  function airborneFrame(ch) {
    return (!player.onGround || rocketRide) ? ch.jump : ch.land;
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

  function drawHeartIcon(cx, cy, s, filled) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + s * 0.85);
    ctx.bezierCurveTo(cx - s * 1.15, cy + s * 0.15, cx - s * 0.9, cy - s * 0.9, cx, cy - s * 0.28);
    ctx.bezierCurveTo(cx + s * 0.9, cy - s * 0.9, cx + s * 1.15, cy + s * 0.15, cx, cy + s * 0.85);
    ctx.closePath();
    ctx.fillStyle = filled ? "#ff4d6d" : "rgba(255,255,255,0.08)";
    ctx.strokeStyle = filled ? "#ffd0da" : "rgba(255,180,196,0.9)";
    ctx.lineWidth = 1.6;
    ctx.fill();
    ctx.stroke();
  }

  function drawRocketIcon(cx, cy, s) {
    ctx.fillStyle = "#ffd24a";
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.26, cy + s * 0.32);
    ctx.lineTo(cx, cy + s * 1.05);
    ctx.lineTo(cx + s * 0.26, cy + s * 0.32);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ff7a3c";
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.28, cy + s * 0.02);
    ctx.lineTo(cx - s * 0.86, cy + s * 0.7);
    ctx.lineTo(cx - s * 0.28, cy + s * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.28, cy + s * 0.02);
    ctx.lineTo(cx + s * 0.86, cy + s * 0.7);
    ctx.lineTo(cx + s * 0.28, cy + s * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#f4f7ff";
    ctx.beginPath();
    ctx.moveTo(cx, cy - s * 1.05);
    ctx.lineTo(cx + s * 0.38, cy - s * 0.15);
    ctx.lineTo(cx + s * 0.38, cy + s * 0.48);
    ctx.lineTo(cx - s * 0.38, cy + s * 0.48);
    ctx.lineTo(cx - s * 0.38, cy - s * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = "#9fb4d6";
    ctx.stroke();
    ctx.fillStyle = "#3aa0ff";
    ctx.beginPath();
    ctx.arc(cx, cy - s * 0.02, Math.max(1.2, s * 0.16), 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSpringIcon(cx, cy, s) {
    ctx.lineWidth = 1.7;
    ctx.strokeStyle = "#e9ff9a";
    ctx.fillStyle = "rgba(190, 255, 70, 0.2)";
    const n = 4;
    for (let i = 0; i < n; i++) {
      const yy = cy - s * 0.95 + i * ((s * 1.9) / (n - 1));
      ctx.beginPath();
      ctx.ellipse(cx, yy, s * 0.72, s * 0.26, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawItemIcon(kind, cx, cy, size) {
    const img = itemImage(kind);
    const d = size || ITEM_DRAW;
    if (frameReady(img)) {
      ctx.drawImage(img, cx - d / 2, cy - d / 2, d, d);
      return;
    }
    if (kind === "life") drawHeartIcon(cx, cy, d * 0.42, true);
    else if (kind === "rocket") drawRocketIcon(cx, cy, d * 0.42);
    else drawSpringIcon(cx, cy, d * 0.42);
  }

  function drawItem(p) {
    if (!p.item || p.item.got || p.gone || p.ghost) return;
    const s = worldToScreen(p.x, p.y - ITEM_LIFT);
    if (s.y < -30 || s.y > H + 30) return;
    ctx.save();
    if (p.blink && p.solid === false) ctx.globalAlpha = 0.22;
    drawItemIcon(p.item.kind, s.x, s.y, ITEM_DRAW);
    ctx.restore();
  }

  function drawItemBursts() {
    for (const b of itemBursts) {
      const u = b.t / b.dur;
      if (u < 0 || u >= 1) continue;
      const s = worldToScreen(b.x, b.y);
      let scale = 1;
      let alpha = 1;
      if (u < 0.38) {
        const k = u / 0.38;
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        scale = 0.45 + (1.75 - 0.45) * e;
      } else {
        const k = (u - 0.38) / 0.62;
        scale = 1.75 - 0.55 * k;
        alpha = 1 - k;
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2 + 0.5;
          const dist = 8 + k * 32;
          ctx.save();
          ctx.globalAlpha = (1 - k) * 0.8;
          drawItemIcon(b.kind, s.x + Math.cos(ang) * dist, s.y + Math.sin(ang) * dist * 0.7, ITEM_DRAW * (0.4 - 0.18 * k));
          ctx.restore();
        }
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(s.x, s.y);
      ctx.scale(scale, scale);
      drawItemIcon(b.kind, 0, 0, ITEM_DRAW);
      ctx.restore();
    }
  }

  function drawPickupBanner() {
    if (!pickupBanner || !running) return;
    const t = pickupBanner.t;
    const a = t < 0.1 ? t / 0.1 : t > 0.62 ? Math.max(0, (PICKUP_BANNER - t) / 0.18) : 1;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(W / 2, H * 0.46);
    ctx.fillStyle = "rgba(8,14,28,0.9)";
    roundRect(ctx, -84, -20, 168, 40, 20);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, -84, -20, 168, 40, 20);
    ctx.stroke();
    drawItemIcon(pickupBanner.kind, -50, 0, 9);
    ctx.fillStyle = "#f4f7ff";
    ctx.font = "bold 16px system-ui,sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(ITEM_LABEL[pickupBanner.kind] || "", -32, 1);
    ctx.restore();
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
    const punch = punchOffset();
    if (punch) ctx.setTransform(scale, 0, 0, scale, ox, oy + punch * scale);

    drawBackground();
    drawWind();
    for (const p of platforms) drawPlatform(p);
    for (const p of platforms) drawItem(p);
    drawStars();
    drawParticles();
    drawPlayer();
    drawItemBursts();
    drawHint();
    drawPickupBanner();
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
    syncItemHud();
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
    PLAYER_H,
    PLAYER_SCALE,
    SPRITE_SCALE,
    EDGE_INSET,
    SCREEN_PAD,
    LAND_HALF,
    JUMP_HALF,
    JUMP_TOP,
    CROWN,
    SPAWN_MARGIN,
    clampAirX,
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
        playerVy: player.vy,
        playerW: player.w,
        playerH: player.h,
        cameraY,
        character: characterId,
        pose: player.pose,
        jumping: player.jumping,
        springJump: player.springJump,
        extraLives: extraLives,
        springJumps: springJumps,
        fallGrace: fallGrace,
        rocket: !!rocketRide,
        pickupBurst: itemBursts.length ? { n: itemBursts.length, t: itemBursts[0].t, dur: itemBursts[0].dur, kind: itemBursts[0].kind } : null,
        artReady: frameReady(CHARS.guagua.land) && frameReady(CHARS.guagua.jump) && frameReady(CHARS.guagua.rocket) && frameReady(CHARS.guagua.spring) && frameReady(CHARS.zhizhi.land) && frameReady(CHARS.zhizhi.jump) && frameReady(CHARS.zhizhi.rocket) && frameReady(CHARS.zhizhi.spring) && frameReady(itemImage("life")) && frameReady(itemImage("rocket")) && frameReady(itemImage("spring")),
        lastFloor: player.lastFloor || 0,
        items: platforms.filter(function (p) { return p.item && !p.item.got; }).map(function (p) {
          return { floor: p.floor || 0, kind: p.item.kind, y: p.y };
        }),
      };
    },
    debug: {
      step: function (dt) {
        const now = performance.now();
        if (running && !gameOver) {
          updatePlatforms(dt, now);
          updatePlayer(dt);
          updateParticles(dt);
          ensurePlatforms();
        } else {
          updateParticles(dt);
        }
        render();
      },
      setLives: function (n) {
        extraLives = Math.max(0, Math.min(2, n));
        syncItemHud();
      },
      setSpring: function (n) {
        springJumps = Math.max(0, n);
        syncItemHud();
      },
      setScore: function (n) {
        score = Math.max(0, n);
        scoreEl.textContent = String(score);
      },
      lifeChance: lifeChance,
      rocketBanned: rocketPathTimed,
      seedRules: function (ids) {
        ruleSeed = ids ? ids.slice() : null;
      },
      forceItem: function (kind) {
        if (!standingPlatform) return false;
        standingPlatform.item = { kind: kind, got: false };
        return true;
      },
      collectStanding: function () {
        if (!standingPlatform) return false;
        collectItem(standingPlatform);
        return true;
      },
      spawnOne: function () {
        const top = highestFloorPlatform();
        const next = spawnNext(top, score);
        platforms.push(next);
        return next.floor;
      },
      destroyStanding: function () {
        if (!standingPlatform) return null;
        standingPlatform.gone = true;
        const fate = footingFate();
        if (fate === "revive") revive();
        else if (fate !== "absorb") {
          player.onGround = false;
          standingPlatform = null;
          player.platOffset = 0;
        }
        platforms = platforms.filter(function (p) { return !p.gone; });
        return standingPlatform;
      },
      nudgeOntoNext: function () {
        const next = platformAtFloor((player.lastFloor || 0) + 1);
        if (!next || !standingPlatform) return null;
        const reach = standingPlatform.w / 2 - player.w / 2;
        let offset = next.x - standingPlatform.x;
        if (offset > reach) offset = reach;
        if (offset < -reach) offset = -reach;
        player.platOffset = offset;
        player.x = standingPlatform.x + offset;
        return { floor: next.floor, nextX: next.x, playerX: player.x, nextY: next.y, nextW: next.w };
      },
      freezePlatforms: function () {
        for (const p of platforms) {
          p.amp = 0;
          p.vx = 0;
          p.x = p.baseX;
        }
      },
      yeet: function () {
        player.onGround = false;
        standingPlatform = null;
        player.platOffset = 0;
        player.y = cameraY + H + 80;
        player.vy = 200;
      },
      slideOff: function () {
        if (!standingPlatform) return false;
        player.slide = 400;
        player.platOffset = standingPlatform.w / 2 + 8;
        return true;
      },
      setPadWidth: function (w) {
        if (standingPlatform) standingPlatform.w = w;
        if (lastSafe) lastSafe.w = w;
      },
      setAirborne: function (x, y, vy) {
        player.onGround = false;
        standingPlatform = null;
        player.jumping = true;
        player.springJump = false;
        player.vx = 0;
        player.platOffset = 0;
        player.x = x;
        if (y != null) player.y = y;
        player.vy = vy || 0;
      },
    },
  };
})();
