(() => {
  const cv = document.getElementById("bg");
  const ctx = cv.getContext("2d", { alpha: false });
  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  const FPS = 30;
  const SCALE = 2;
  const COLORS = { off: [0, 200, 90], on: [0, 255, 102], connecting: [255, 212, 0], error: [255, 59, 78] };
  const SPEED = { off: 0.55, on: 0.85, connecting: 1.5, error: 0.45 };

  let W = 0, H = 0, fw = 0, fh = 0;
  let field, img, small, sctx;
  let blobs = [], dust = [];
  let mode = "off";
  let col = [...COLORS.off];
  let last = 0, raf = 0, clock = 0;
  const mouse = { x: -999, y: -999 };

  const sprite = document.createElement("canvas");
  function paintSprite() {
    const s = 48;
    sprite.width = sprite.height = s;
    const g = sprite.getContext("2d");
    const [r, gg, b] = col.map(Math.round);
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, `rgba(${r},${gg},${b},1)`);
    grd.addColorStop(0.25, `rgba(${r},${gg},${b},.45)`);
    grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.clearRect(0, 0, s, s);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }

  function resize() {
    W = cv.clientWidth;
    H = cv.clientHeight;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    fw = Math.ceil(W / SCALE);
    fh = Math.ceil(H / SCALE);
    field = new Float32Array(fw * fh);
    small = document.createElement("canvas");
    small.width = fw;
    small.height = fh;
    sctx = small.getContext("2d");
    img = sctx.createImageData(fw, fh);
  }

  function seed() {
    blobs = [];
    const n = 14;
    for (let i = 0; i < n; i++) {
      blobs.push({
        cx: W * (0.1 + 0.8 * Math.random()),
        cy: H * (0.1 + 0.8 * Math.random()),
        ax: 14 + Math.random() * 36,
        ay: H * (0.18 + Math.random() * 0.3),
        wx: 0.14 + Math.random() * 0.2,
        wy: 0.08 + Math.random() * 0.14,
        px: Math.random() * 6.28,
        py: Math.random() * 6.28,
        r: 8 + Math.random() * 17,
        x: 0, y: 0, ox: 0, oy: 0,
      });
    }
    dust = [];
    for (let i = 0; i < 16; i++) {
      dust.push({ x: Math.random() * W, y: Math.random() * H, v: 0.15 + Math.random() * 0.4, s: 6 + Math.random() * 14, ph: Math.random() * 6.28 });
    }
  }

  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  function step(dt) {
    clock += dt * SPEED[mode];
    for (const b of blobs) {
      const tx = b.cx + Math.sin(clock * b.wx + b.px) * b.ax;
      const ty = b.cy + Math.sin(clock * b.wy + b.py) * b.ay;
      let dx = tx - mouse.x, dy = ty - mouse.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 130 * 130) {
        const k = (1 - Math.sqrt(d2) / 130) * 38;
        const d = Math.sqrt(d2) || 1;
        b.ox += (dx / d) * k;
        b.oy += (dy / d) * k;
      }
      b.ox *= 0.9;
      b.oy *= 0.9;
      b.x = tx + b.ox;
      b.y = ty + b.oy;
    }
    for (const p of dust) {
      p.y -= p.v * dt * 60 * SPEED[mode];
      p.x += Math.sin(clock * 0.6 + p.ph) * 0.25;
      if (p.y < -20) { p.y = H + 20; p.x = Math.random() * W; }
    }
  }

  function renderSlime() {
    const n = blobs.length;
    for (let j = 0; j < fh; j++) {
      const py = j * SCALE;
      for (let i = 0; i < fw; i++) {
        const px = i * SCALE;
        let f = 0;
        for (let k = 0; k < n; k++) {
          const b = blobs[k];
          const dx = px - b.x, dy = py - b.y;
          f += (b.r * b.r) / (dx * dx + dy * dy + 40);
        }
        field[j * fw + i] = f;
      }
    }
    const [cr, cg, cb] = col;
    const data = img.data;
    const lx = -0.55, ly = -0.8;
    for (let j = 0; j < fh; j++) {
      for (let i = 0; i < fw; i++) {
        const idx = j * fw + i;
        const f = field[idx];
        const o = idx * 4;
        const edge = smooth(0.9, 1.04, f);
        if (edge <= 0) { data[o + 3] = 0; continue; }
        const fx = field[j * fw + Math.min(fw - 1, i + 1)] - field[j * fw + Math.max(0, i - 1)];
        const fy = field[Math.min(fh - 1, j + 1) * fw + i] - field[Math.max(0, j - 1) * fw + i];
        const len = Math.hypot(fx, fy) + 1e-4;
        const nx = -fx / len, ny = -fy / len;
        const rim = Math.exp(-(f - 1) * 2.4);
        const diff = Math.max(0, nx * lx + ny * ly);
        const spec = Math.pow(diff, 14) * rim;
        const core = Math.min(1, f / 3.2);
        const depth = 0.16 + 0.42 * core;
        const m = depth + rim * 0.55 + diff * 0.25 * rim;
        data[o] = Math.min(255, cr * m + spec * 210 + 18);
        data[o + 1] = Math.min(255, cg * m + spec * 255 + 24);
        data[o + 2] = Math.min(255, cb * m + spec * 215 + 18);
        data[o + 3] = 255 * edge * Math.min(1, 0.26 + 0.22 * core + rim * 0.5 + spec * 0.4);
      }
    }
    sctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, fw * SCALE, fh * SCALE);
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < 1000 / FPS) return;
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;

    const tgt = COLORS[mode] || COLORS.off;
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const d = tgt[i] - col[i];
      if (Math.abs(d) > 0.5) { col[i] += d * 0.08; changed = true; }
    }
    if (changed) paintSprite();
    const [r, g, b] = col.map(Math.round);

    step(dt);

    const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.9);
    bg.addColorStop(0, "#07281a");
    bg.addColorStop(1, "#020604");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    for (const p of dust) {
      const s = p.s * (1 + Math.sin(clock * 1.2 + p.ph) * 0.12) * 2;
      ctx.globalAlpha = 0.25 + (p.s / 20) * 0.35;
      ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    renderSlime();

    const glow = ctx.createLinearGradient(0, H * 0.6, 0, H);
    glow.addColorStop(0, `rgba(${r},${g},${b},0)`);
    glow.addColorStop(1, `rgba(${r},${g},${b},.10)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
  }

  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  resize();
  paintSprite();
  seed();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { frame(1e9); stop(); }
  else start();

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  addEventListener("mouseleave", () => { mouse.x = mouse.y = -999; });

  window.setBgMode = (m) => { mode = m; };
})();
