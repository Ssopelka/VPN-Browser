(() => {
  const cv = document.getElementById("bg");
  const ctx = cv.getContext("2d", { alpha: false });
  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  const FPS = 30;
  const THEMES = {
    off: { c: [108, 170, 130], bg0: [15, 31, 23], bg1: [5, 8, 6], speed: 0.5 },
    connecting: { c: [255, 200, 0], bg0: [37, 29, 5], bg1: [9, 7, 0], speed: 1.4 },
    on: { c: [0, 255, 102], bg0: [7, 40, 26], bg1: [2, 6, 4], speed: 0.8 },
    error: { c: [255, 59, 78], bg0: [36, 7, 9], bg1: [9, 2, 3], speed: 0.45 },
  };
  const LAYERS = [
    { n: 9, r0: 6, r1: 13, scale: 3, speed: 0.6, alpha: 0.5, bright: 0.65, mouse: 0, wobble: 1.6, bubbles: 0 },
    { n: 12, r0: 8, r1: 22, scale: 1.5, speed: 1, alpha: 1, bright: 0.95, mouse: 1, wobble: 2.4, bubbles: 2 },
    { n: 5, r0: 20, r1: 32, scale: 2, speed: 1.3, alpha: 0.85, bright: 1.05, mouse: 1.6, wobble: 3, bubbles: 3 },
  ];

  let W = 0, H = 0;
  let layers = [], dust = [];
  let mode = "off";
  const cur = { c: [...THEMES.off.c], bg0: [...THEMES.off.bg0], bg1: [...THEMES.off.bg1] };
  let last = 0, raf = 0, clock = 0;
  const mouse = { x: -999, y: -999 };

  const sprite = document.createElement("canvas");
  function paintSprite() {
    const s = 48;
    sprite.width = sprite.height = s;
    const g = sprite.getContext("2d");
    const [r, gg, b] = cur.c.map(Math.round);
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, `rgba(${r},${gg},${b},1)`);
    grd.addColorStop(0.25, `rgba(${r},${gg},${b},.45)`);
    grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.clearRect(0, 0, s, s);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }

  function makeLayer(cfg) {
    const fw = Math.ceil(W / cfg.scale), fh = Math.ceil(H / cfg.scale);
    const canvas = document.createElement("canvas");
    canvas.width = fw;
    canvas.height = fh;
    const sctx = canvas.getContext("2d");
    const blobs = [];
    for (let i = 0; i < cfg.n; i++) {
      blobs.push({
        cx: W * (0.05 + 0.9 * Math.random()),
        cy: H * (0.05 + 0.9 * Math.random()),
        ax: 12 + Math.random() * 38,
        ay: H * (0.15 + Math.random() * 0.3),
        wx: 0.14 + Math.random() * 0.2,
        wy: 0.08 + Math.random() * 0.14,
        px: Math.random() * 6.28,
        py: Math.random() * 6.28,
        r: cfg.r0 + Math.random() * (cfg.r1 - cfg.r0),
        spin: (Math.random() < 0.5 ? -1 : 1) * (0.2 + Math.random() * 0.3),
        x: 0, y: 0, ox: 0, oy: 0,
      });
    }
    return {
      cfg, fw, fh, canvas, sctx, blobs,
      img: sctx.createImageData(fw, fh),
      field: new Float32Array(fw * fh),
      rowW: new Float32Array(fh),
      colW: new Float32Array(fw),
    };
  }

  function resize() {
    W = cv.clientWidth;
    H = cv.clientHeight;
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    layers = LAYERS.map(makeLayer);
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
    clock += dt * THEMES[mode].speed;
    for (const L of layers) {
      const { speed, mouse: mk } = L.cfg;
      for (const b of L.blobs) {
        const tx = b.cx + Math.sin(clock * speed * b.wx + b.px) * b.ax;
        const ty = b.cy + Math.sin(clock * speed * b.wy + b.py) * b.ay;
        const dx = tx - mouse.x, dy = ty - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (mk && d2 < 130 * 130) {
          const d = Math.sqrt(d2) || 1;
          const k = (1 - d / 130) * 38 * mk;
          b.ox += (dx / d) * k;
          b.oy += (dy / d) * k;
        }
        b.ox *= 0.9;
        b.oy *= 0.9;
        b.x = tx + b.ox;
        b.y = ty + b.oy;
      }
    }
    for (const p of dust) {
      p.y -= p.v * dt * 60 * THEMES[mode].speed;
      p.x += Math.sin(clock * 0.6 + p.ph) * 0.25;
      if (p.y < -20) { p.y = H + 20; p.x = Math.random() * W; }
    }
  }

  function renderLayer(L) {
    const { fw, fh, field, blobs, img, cfg, rowW, colW } = L;
    const sc = cfg.scale;
    const n = blobs.length;
    for (let j = 0; j < fh; j++) rowW[j] = Math.sin(j * sc * 0.05 + clock * 0.9) * cfg.wobble;
    for (let i = 0; i < fw; i++) colW[i] = Math.sin(i * sc * 0.045 + clock * 0.7 + 1.3) * cfg.wobble;
    for (let j = 0; j < fh; j++) {
      const wx = rowW[j];
      for (let i = 0; i < fw; i++) {
        const px = i * sc + wx, py = j * sc + colW[i];
        let f = 0;
        for (let k = 0; k < n; k++) {
          const b = blobs[k];
          const dx = px - b.x, dy = py - b.y;
          f += (b.r * b.r) / (dx * dx + dy * dy + 40);
        }
        field[j * fw + i] = f;
      }
    }
    const [cr, cg, cb] = cur.c;
    const data = img.data;
    for (let j = 0; j < fh; j++) {
      const jm = Math.max(0, j - 1) * fw, jp = Math.min(fh - 1, j + 1) * fw, jr = j * fw;
      for (let i = 0; i < fw; i++) {
        const idx = jr + i;
        const f = field[idx];
        const o = idx * 4;
        const edge = smooth(0.88, 1.08, f);
        if (edge <= 0) { data[o + 3] = 0; continue; }
        const fx = field[jr + Math.min(fw - 1, i + 1)] - field[jr + Math.max(0, i - 1)];
        const fy = field[jp + i] - field[jm + i];
        const len = Math.hypot(fx, fy) + 1e-4;
        const nx = -fx / len, ny = -fy / len;
        const rim = Math.exp(-(f - 1) * 2.4);
        const key = Math.max(0, nx * -0.55 + ny * -0.8);
        const fill = Math.max(0, nx * 0.6 + ny * 0.7);
        const spec = Math.pow(key, 16) * rim;
        const spec2 = Math.pow(fill, 9) * rim * 0.45;
        const core = Math.min(1, f / 3.4);
        const inner = smooth(1.3, 3.4, f);
        const ring = smooth(0.9, 1.03, f) * (1 - smooth(1.03, 1.22, f));
        const dark = 1 - 0.4 * ring;
        const m = (0.14 + 0.4 * core + rim * 0.5 + key * 0.22 * rim + fill * 0.12 * rim) * cfg.bright * dark;
        const glow = inner * 26;
        data[o] = Math.min(255, cr * m + spec * 210 + spec2 * 120 + glow * (cr / 255) + 16);
        data[o + 1] = Math.min(255, cg * m + spec * 255 + spec2 * 150 + glow * (cg / 255) + 22);
        data[o + 2] = Math.min(255, cb * m + spec * 215 + spec2 * 130 + glow * (cb / 255) + 16);
        data[o + 3] = 255 * edge * cfg.alpha * Math.min(1, 0.22 + 0.26 * core + rim * 0.5 + spec * 0.4 + inner * 0.12);
      }
    }
    L.sctx.putImageData(img, 0, 0);
    ctx.drawImage(L.canvas, 0, 0, fw * sc, fh * sc);
    if (cfg.bubbles) drawBubbles(L);
  }

  function drawBubbles(L) {
    const { blobs, cfg, field, fw, fh } = L;
    const sc = cfg.scale;
    for (const b of blobs) {
      if (b.r < 11) continue;
      for (let k = 0; k < cfg.bubbles; k++) {
        const ang = clock * 0.35 * b.spin + k * 2.4 + b.px;
        const off = b.r * (0.22 + 0.16 * k);
        const x = b.x + Math.cos(ang) * off, y = b.y + Math.sin(ang * 1.3) * off * 0.8;
        const fi = Math.min(fw - 1, Math.max(0, Math.round(x / sc))), fj = Math.min(fh - 1, Math.max(0, Math.round(y / sc)));
        const inside = smooth(1.6, 2.6, field[fj * fw + fi]);
        if (inside <= 0) continue;
        const br = b.r * (0.13 + 0.05 * k);
        const gr = ctx.createRadialGradient(x - br * 0.3, y - br * 0.35, br * 0.05, x, y, br);
        gr.addColorStop(0, `rgba(255,255,255,${0.34 * inside})`);
        gr.addColorStop(0.3, `rgba(255,255,255,${0.05 * inside})`);
        gr.addColorStop(0.8, `rgba(255,255,255,0)`);
        gr.addColorStop(1, `rgba(255,255,255,${0.3 * inside})`);
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(x, y, br, 0, 6.2832);
        ctx.fill();
      }
    }
  }

  function lerpTo(cur3, tgt3, k) {
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const d = tgt3[i] - cur3[i];
      if (Math.abs(d) > 0.4) { cur3[i] += d * k; changed = true; }
    }
    return changed;
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < 1000 / FPS) return;
    const dt = Math.min(0.1, (t - last) / 1000);
    last = t;

    const th = THEMES[mode] || THEMES.off;
    if (lerpTo(cur.c, th.c, 0.08)) paintSprite();
    lerpTo(cur.bg0, th.bg0, 0.08);
    lerpTo(cur.bg1, th.bg1, 0.08);
    const [r, g, b] = cur.c.map(Math.round);

    step(dt);

    const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.9);
    bg.addColorStop(0, `rgb(${cur.bg0.map(Math.round)})`);
    bg.addColorStop(1, `rgb(${cur.bg1.map(Math.round)})`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    renderLayer(layers[0]);

    for (const p of dust) {
      const s = p.s * (1 + Math.sin(clock * 1.2 + p.ph) * 0.12) * 2;
      ctx.globalAlpha = 0.25 + (p.s / 20) * 0.35;
      ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    renderLayer(layers[1]);
    renderLayer(layers[2]);

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
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { frame(1e9); stop(); }
  else start();

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  addEventListener("mouseleave", () => { mouse.x = mouse.y = -999; });

  window.setBgMode = (m) => { mode = THEMES[m] ? m : "off"; };
})();
