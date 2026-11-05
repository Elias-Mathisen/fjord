// Ski jump: the game on the "you're offline" page (page-frame.js puts it there). An endless downhill run: Space, ↑, a
// click or a tap jumps over rocks and trees, and at the lip of each ski jump it launches you over the crevasse after
// it, furthest when you press right at the lip ("Perfect!"). It gets faster, and the crevasses wider, the further you go.
// Drawn in the page's own text colour, so it suits light and dark.
const W = 600, H = 200, SLOPE = 0.12, P = 3; // canvas size, downhill gradient, pixel size of the sprites
const SKIER_X = 90, LINE_Y = 74; // where the skier and the slope sit on screen
const G = 0.42, JUMP = -7, PERFECT = -9.6, RAMP = 20; // gravity, jump kicks, height of a ski jump's lip
const START_SPEED = 4.6, MAX_SPEED = 11.5;

// Sprites: one character per pixel, # filled
const sprite = rows => rows.map(r => [...r]);
const SKIER = sprite([
  "......##..",
  ".....####.",
  "......##..",
  "....####..",
  "...##.###.",
  "..##..###.",
  ".....####.",
  "....##.##.",
  "...##...#.",
]);
const FLYING = sprite([
  "........##",
  ".......####",
  "......###..",
  ".....###...",
  "...####....",
  "..###.#....",
  ".##...#....",
]);
const FALLEN = sprite([
  "..........##.",
  "...#.....####",
  "....#.####.##",
  ".#####.###...",
  "#...#.#......",
]);
const TREE = sprite([
  ".....#.....",
  "....###....",
  "...#####...",
  "..#######..",
  "...#####...",
  ".#########.",
  "...#####...",
  ".#########.",
  "###########",
  ".....#.....",
  ".....#.....",
]);
const ROCK = sprite([
  "...####...",
  ".#######..",
  "##########",
]);

// The best distance, kept by the browser (page-frame.js passes it in and saves new ones)
export function startSkiJump(win, container, { best = 0, saveBest = () => {} } = {}) {
  const doc = win.document;
  const canvas = doc.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Ski jump game. Press Space to start and to jump.");
  canvas.style.cssText = `display:block; width:100%; max-width:${W}px; aspect-ratio:${W}/${H}; margin:0 0 24px; cursor:pointer; touch-action:manipulation`;
  container.prepend(canvas);
  const ctx = canvas.getContext("2d");
  const ink = win.getComputedStyle(doc.body).color;

  let state, raf = 0, last = 0, acc = 0;
  function reset() {
    state = {
      mode: state ? "playing" : "idle", x: 0, y: 0, vy: 0, air: false, speed: START_SPEED,
      features: [], next: 700, perfectUntil: 0, flash: 0, wipeAt: 0, t: 0, lift: 0,
    };
    state.y = ground(0);
  }

  // ---------- The slope ----------
  // Downhill forever, with gentle bumps, and ski jumps: a ramp rising to a lip, then a crevasse (no ground)
  const bump = x => 2.2 * Math.sin(x / 70) + 1.4 * Math.sin(x / 23);
  function ground(x) {
    for (const f of state.features) {
      if (f.type !== "jump" || x < f.start || x > f.end) continue;
      if (x > f.lip) return null; // the crevasse
      const t = (x - f.start) / (f.lip - f.start);
      return SLOPE * x - RAMP * t * t;
    }
    return SLOPE * x + bump(x);
  }
  // How far a launch from a lip carries, at a speed, for sizing the crevasses
  function flight(vy, speed) {
    let x = 0, y = -RAMP;
    for (let i = 0; i < 400; i++) {
      x += speed; vy += G; y += vy;
      if (y >= SLOPE * x) return x;
    }
    return x;
  }
  // Rocks, trees and ski jumps ahead of the skier, closer together and harder as the run goes on
  function plan() {
    const hard = Math.min(1, state.x / 30000); // all the way hard after 3,000 m, about when the top speed is reached
    while (state.next < state.x + W * 2) {
      const r = Math.random(), x = state.next;
      if (r < 0.22 + 0.12 * hard) {
        // A crevasse any jump clears at first; later only a well-timed one does
        const v = state.speed, ramp = 70 + v * 8;
        const none = flight((SLOPE - 2 * RAMP / ramp) * v, v), jump = flight(JUMP, v), perfect = flight(PERFECT, v);
        // Just wider than riding off the lip at first, so any jump clears it; a jump at the flag is needed later
        const need = hard < 0.5 ? none * 1.15 + (jump * 0.8 - none * 1.15) * hard * 2 : jump * 0.8 + (perfect - jump * 0.8) * (hard - 0.5) * 1.6;
        const lip = x + ramp;
        state.features.push({ type: "jump", start: x, lip, end: lip + Math.min(need, perfect * 0.88) });
        state.next = lip + need + 260 + v * 20;
      } else {
        const tree = Math.random() < 0.45 + 0.2 * hard;
        state.features.push({ type: tree ? "tree" : "rock", x, art: tree ? TREE : ROCK });
        // Sometimes two in a row, later on
        if (hard > 0.3 && Math.random() < hard * 0.4) state.features.push({ type: "rock", x: x + 26 + Math.random() * 20, art: ROCK });
        // Never closer than one jump carries at this speed, plus a moment to react, so every run can be cleared
        state.next = x + state.speed * (2 * -JUMP / G + 12 + Math.random() * (40 - 22 * hard));
      }
    }
    state.features = state.features.filter(f => (f.end ?? f.x) > state.x - W);
  }

  // ---------- Playing ----------
  const onRamp = () => state.features.find(f => f.type === "jump" && state.x >= f.start && state.x <= f.lip);
  const say = text => canvas.setAttribute("aria-label", text);
  function press() {
    if (state.mode === "idle") { state.mode = "playing"; say("Ski jump game: skiing."); return; }
    if (state.mode === "wiped") { if (Date.now() - state.wipeAt > 450) { reset(); say("Ski jump game: skiing."); } return; }
    if (state.air) return;
    const ramp = onRamp();
    // Right at the bottom of the jump (the lip): the big one
    if (ramp && ramp.lip - state.x < Math.max(28, state.speed * 6.5)) {
      state.vy = PERFECT;
      state.perfectUntil = state.t + 50;
    } else state.vy = JUMP;
    state.air = true;
  }
  function wipeout() {
    state.mode = "wiped";
    state.wipeAt = Date.now();
    const score = Math.floor(state.x / 10);
    if (score > best) { best = score; saveBest(best); }
    say(`Ski jump game: wipeout at ${score} m. Best ${best} m. Press Space to go again.`);
  }
  function step() {
    const s = state;
    s.t++;
    s.speed = Math.min(MAX_SPEED, s.speed + 0.0014);
    plan();
    s.x += s.speed;
    const here = ground(s.x);
    if (!s.air) {
      if (here === null) s.air = true; // off the lip, carried by the ramp's own lift (vy from the last step)
      else { s.vy = here - s.y; s.y = here; }
    }
    if (s.air) {
      s.vy += G;
      s.y += s.vy;
      if (here !== null && s.y >= here) {
        // Came out of the crevasse below its far edge: into the wall
        if (s.y - here > 6 && ground(s.x - s.speed) === null) return wipeout();
        s.y = here; s.vy = 0; s.air = false;
      }
      else if (here === null && s.y > SLOPE * s.x + 46) return wipeout(); // down the crevasse
    }
    // Rocks and trees: the skier's feet against the obstacle's top, with a little give
    for (const f of s.features) {
      if (f.type === "jump") continue;
      const w = f.art[0].length * P, h = f.art.length * P;
      if (s.x + 18 > f.x + 4 && s.x - 6 < f.x + w - 4 && s.y > ground(f.x) - h + 4) return wipeout();
    }
    const m = Math.floor(s.x / 10);
    if (m > 0 && m % 100 === 0 && Math.floor((s.x - s.speed) / 10) % 100 !== 0) s.flash = 40;
  }

  // ---------- Drawing ----------
  function draw() {
    const s = state;
    const dpr = win.devicePixelRatio || 1;
    if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = ctx.strokeStyle = ink;
    // The camera follows the slope, and rises with the skier on a big jump
    const camX = s.x - SKIER_X, slopeCam = SLOPE * camX - LINE_Y;
    s.lift += (Math.min(0, s.y - 44 - slopeCam) - s.lift) * 0.15;
    const camY = slopeCam + s.lift;
    const sy = y => y - camY;

    // The snow line, with flecks below it; gaps where the crevasses are
    for (let px = 0; px < W; px += 2) {
      const gx = camX + px, gy = ground(gx);
      if (gy === null) continue;
      ctx.fillRect(px, Math.round(sy(gy)), 2, 2);
      const seed = Math.floor(gx / 2);
      if ((seed * 2654435761 >>> 0) % 23 === 0) ctx.fillRect(px, Math.round(sy(gy)) + 6 + (seed % 5) * 4, 2, 1);
    }
    for (const f of s.features) {
      if (f.type === "jump") {
        const lx = f.lip - camX, ex = f.end - camX;
        if (ex < -10 || lx > W + 10) continue;
        const ly = sy(ground(f.lip)), ey = sy(SLOPE * f.end + bump(f.end));
        ctx.fillRect(lx, ly, 2, ey - ly + 40); // the crevasse's walls
        ctx.fillRect(ex, ey, 2, 40);
        ctx.fillRect(lx - 1, ly - 14, 1, 14); // a flag on the lip, to time the jump by
        ctx.beginPath(); ctx.moveTo(lx, ly - 14); ctx.lineTo(lx + 7, ly - 11); ctx.lineTo(lx, ly - 8); ctx.fill();
      } else {
        const x = f.x - camX;
        if (x < -30 || x > W + 30) continue;
        paint(f.art, x, sy(ground(f.x)) - f.art.length * P);
      }
    }

    // The skier: tucked along the slope, a V in the air, in a heap after a wipeout
    const px = SKIER_X, py = sy(s.y);
    ctx.save();
    ctx.translate(px, py);
    if (s.mode === "wiped") {
      paint(FALLEN, -16, -FALLEN.length * P);
    } else if (s.air) {
      ctx.rotate(Math.max(-0.35, Math.min(0.45, s.vy * 0.05)));
      ctx.fillRect(-14, -1, 44, 3); // skis in a V
      ctx.save(); ctx.rotate(-0.28); ctx.fillRect(-14, -1, 42, 3); ctx.restore();
      paint(FLYING, -9, -FLYING.length * P - 1);
    } else {
      ctx.rotate(Math.atan(SLOPE));
      ctx.fillRect(-16, -1, 46, 3);
      ctx.fillRect(27, -4, 3, 3); // ski tips
      paint(SKIER, -10, -SKIER.length * P - 1);
    }
    ctx.restore();

    // Distance in metres, and the best run
    ctx.font = "bold 13px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "right";
    const m = String(Math.floor(s.x / 10)).padStart(5, "0");
    ctx.globalAlpha = 0.6;
    ctx.fillText(`HI ${String(best).padStart(5, "0")}`, W - 74, 20);
    ctx.globalAlpha = s.flash > 0 && Math.floor(s.flash / 8) % 2 ? 0.15 : 1;
    ctx.fillText(`${m} m`, W - 8, 20);
    ctx.globalAlpha = 1;
    if (s.flash > 0) s.flash--;
    ctx.textAlign = "center";
    if (s.t < s.perfectUntil) ctx.fillText("Perfect!", px + 24, py - 44);
    if (s.mode === "idle") {
      ctx.fillText("Press Space to ski", W / 2, H - 44);
      ctx.globalAlpha = 0.6;
      ctx.fillText("Jump the rocks and trees. On a ski jump, press at the flag.", W / 2, H - 24);
      ctx.globalAlpha = 1;
    } else if (s.mode === "wiped") {
      ctx.fillText("Wipeout!", W / 2, H - 44);
      ctx.globalAlpha = 0.6;
      ctx.fillText("Press Space to go again", W / 2, H - 24);
      ctx.globalAlpha = 1;
    }
  }
  function paint(art, x, y) {
    for (let r = 0; r < art.length; r++)
      for (let c = 0; c < art[r].length; c++)
        if (art[r][c] === "#") ctx.fillRect(Math.round(x + c * P), Math.round(y + r * P), P, P);
  }

  // Fixed 60 steps a second, whatever the screen's refresh rate
  function frame(now) {
    raf = win.requestAnimationFrame(frame);
    acc = Math.min(acc + (now - (last || now)), 100);
    last = now;
    while (acc >= 1000 / 60) {
      if (state.mode === "playing") step();
      acc -= 1000 / 60;
    }
    draw();
  }

  const onKey = e => {
    if ((e.code !== "Space" && e.code !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest?.("input, textarea, select")) return;
    e.preventDefault(); // Space would otherwise press the focused "Try Again" button or scroll
    if (!e.repeat) press();
  };
  win.addEventListener("keydown", onKey, true);
  // A focused button is pressed when Space comes back up, so that's the game's too
  win.addEventListener("keyup", e => { if (e.code === "Space" && !e.target.closest?.("input, textarea, select")) e.preventDefault(); }, true);
  canvas.addEventListener("pointerdown", e => { e.preventDefault(); press(); });
  win.addEventListener("pagehide", () => win.cancelAnimationFrame(raf), { once: true });
  reset();
  raf = win.requestAnimationFrame(frame);
  // For tests: the game's state and a way to press
  return { get state() { return state; }, press };
}
