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
    { n: 6, r0: 8, r1: 18, scale: 2, speed: 0.7, alpha: 0.9, bright: 0.8, mouse: 0.6, land: true },
    { n: 9, r0: 6, r1: 13, scale: 4, speed: 0.6, alpha: 0.5, bright: 0.65, mouse: 0 },
    { n: 12, r0: 8, r1: 22, scale: 2, speed: 1, alpha: 1, bright: 0.9, mouse: 1 },
    { n: 5, r0: 20, r1: 32, scale: 3, speed: 1.3, alpha: 0.8, bright: 1, mouse: 1.6 },
  ];


  const WORLD_VIEW = { z: 0.12, lon: 10, lat: 18 };
  const ZOOM_TO = 0.82;
  const LAND_K = 2.6;
  let mapPath = null;
  let target = null;
  const view = { ...WORLD_VIEW };
  let lock = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function buildMap() {
    if (!Array.isArray(window.WORLD)) return;
    mapPath = new Path2D();
    for (const r of window.WORLD) {
      mapPath.moveTo(r[0] / 10, r[1] / 10);
      for (let i = 2; i < r.length; i += 2) {
        if (Math.abs(r[i] - r[i - 2]) > 1800) mapPath.moveTo(r[i] / 10, r[i + 1] / 10);
        else mapPath.lineTo(r[i] / 10, r[i + 1] / 10);
      }
      mapPath.closePath();
    }
  }

  function stepView(dt) {
    const goal = target ? { z: ZOOM_TO, lon: target.lon, lat: target.lat } : WORLD_VIEW;
    const kz = reduced ? 1 : 1 - Math.exp(-dt * 2.1);
    const kp = reduced ? 1 : 1 - Math.exp(-dt * 3.2);
    view.z += (goal.z - view.z) * kz;
    view.lon += (goal.lon - view.lon) * kp;
    view.lat += (goal.lat - view.lat) * kp;
    lock = target ? Math.min(1, Math.max(0, (view.z - WORLD_VIEW.z) / (ZOOM_TO - WORLD_VIEW.z))) : 0;
  }

  const viewScale = () => (W / 360) * Math.exp(view.z * 2.4);
  const focus = () => ({ x: W / 2, y: H * (0.45 + 0.25 * lock) });

  function updateLand(L) {
    if (!mapPath) return;
    const { mctx, fw, fh, land } = L;
    const sc = L.cfg.scale, s = viewScale(), f = focus();
    mctx.clearRect(0, 0, fw, fh);
    mctx.save();
    mctx.filter = "blur(1.8px)";
    mctx.translate((f.x - (view.lon + 180) * s) / sc, (f.y - (90 - view.lat) * s) / sc);
    mctx.scale(s / sc, s / sc);
    mctx.fillStyle = "#fff";
    mctx.fill(mapPath);
    mctx.restore();
    const d = mctx.getImageData(0, 0, fw, fh).data;
    for (let i = 0; i < land.length; i++) land[i] = d[i * 4 + 3] / 255;
  }

  function drawPin(r, g, b) {
    if (!target || lock < 0.2) return;
    const s = viewScale(), f = focus();
    const px = f.x + (target.lon - view.lon) * s, py = f.y + (view.lat - target.lat) * s;
    const a = Math.min(1, (lock - 0.2) / 0.5);
    for (let i = 0; i < 2; i++) {
      const t = (clock * 0.5 + i * 0.5) % 1;
      ctx.strokeStyle = `rgba(${r},${g},${b},${(1 - t) * 0.85 * a})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 6 + t * 34, 0, 6.2832);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.shadowColor = `rgb(${r},${g},${b})`;
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, 6.2832);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

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
        x: 0, y: 0, ox: 0, oy: 0,
      });
    }
    const L = { cfg, fw, fh, canvas, sctx, img: sctx.createImageData(fw, fh), field: new Float32Array(fw * fh), blobs };
    if (cfg.land) {
      const m = document.createElement("canvas");
      m.width = fw;
      m.height = fh;
      L.mctx = m.getContext("2d", { willReadFrequently: true });
      L.land = new Float32Array(fw * fh);
    }
    return L;
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
    const { fw, fh, field, blobs, img, cfg } = L;
    const sc = cfg.scale;
    const n = blobs.length;
    const land = L.land;
    if (land) updateLand(L);
    const base = layers[0];
    for (let j = 0; j < fh; j++) {
      const py = j * sc;
      for (let i = 0; i < fw; i++) {
        const px = i * sc;
        let f = 0;
        for (let k = 0; k < n; k++) {
          const b = blobs[k];
          const dx = px - b.x, dy = py - b.y;
          f += (b.r * b.r) / (dx * dx + dy * dy + 40);
        }
        field[j * fw + i] = land ? f + land[j * fw + i] * LAND_K : f;
      }
    }
    const [cr, cg, cb] = cur.c;
    const data = img.data;
    const lx = -0.55, ly = -0.8;
    for (let j = 0; j < fh; j++) {
      for (let i = 0; i < fw; i++) {
        const idx = j * fw + i;
        const f = field[idx];
        const o = idx * 4;
        const edge = smooth(0.87, 1.07, f);
        if (edge <= 0) { data[o + 3] = 0; continue; }
        const fx = field[j * fw + Math.min(fw - 1, i + 1)] - field[j * fw + Math.max(0, i - 1)];
        const fy = field[Math.min(fh - 1, j + 1) * fw + i] - field[Math.max(0, j - 1) * fw + i];
        const len = Math.hypot(fx, fy) + 1e-4;
        const nx = -fx / len, ny = -fy / len;
        const rim = Math.exp(-(f - 1) * 2.4);
        const diff = Math.max(0, nx * lx + ny * ly);
        const spec = Math.pow(diff, 14) * rim;
        const core = Math.min(1, f / 3.2);
        const m = (0.16 + 0.42 * core + rim * 0.55 + diff * 0.25 * rim) * cfg.bright;
        data[o] = Math.min(255, cr * m + spec * 210 + 18);
        data[o + 1] = Math.min(255, cg * m + spec * 255 + 24);
        data[o + 2] = Math.min(255, cb * m + spec * 215 + 18);
        let a = 255 * edge * cfg.alpha * Math.min(1, 0.26 + 0.22 * core + rim * 0.5 + spec * 0.4);
        if (!land && base.land) {
          const bi = Math.min(base.fh - 1, Math.floor((j * sc) / base.cfg.scale)) * base.fw + Math.min(base.fw - 1, Math.floor((i * sc) / base.cfg.scale));
          a *= 1 - 0.9 * Math.min(1, base.land[bi] * 1.4);
        }
        data[o + 3] = a;
      }
    }
    L.sctx.putImageData(img, 0, 0);
    ctx.drawImage(L.canvas, 0, 0, fw * sc, fh * sc);
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
    stepView(dt);

    const bg = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, H * 0.9);
    bg.addColorStop(0, `rgb(${cur.bg0.map(Math.round)})`);
    bg.addColorStop(1, `rgb(${cur.bg1.map(Math.round)})`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    renderLayer(layers[0]);
    renderLayer(layers[1]);

    for (const p of dust) {
      const s = p.s * (1 + Math.sin(clock * 1.2 + p.ph) * 0.12) * 2;
      ctx.globalAlpha = 0.25 + (p.s / 20) * 0.35;
      ctx.drawImage(sprite, p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;

    renderLayer(layers[2]);
    renderLayer(layers[3]);
    drawPin(r, g, b);

    const glow = ctx.createLinearGradient(0, H * 0.6, 0, H);
    glow.addColorStop(0, `rgba(${r},${g},${b},0)`);
    glow.addColorStop(1, `rgba(${r},${g},${b},.10)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, H * 0.6, W, H * 0.4);
  }

  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  buildMap();
  resize();
  paintSprite();
  if (reduced) { frame(1e9); stop(); }
  else start();

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  addEventListener("mouseleave", () => { mouse.x = mouse.y = -999; });

  window.setBgMode = (m) => { mode = THEMES[m] ? m : "off"; };
  window.setBgTarget = (t) => {
    const ok = t && Number.isFinite(t.lat) && Number.isFinite(t.lon);
    target = ok ? { lat: Math.max(-80, Math.min(80, t.lat)), lon: t.lon } : null;
    if (reduced) { frame(1e9); stop(); }
  };
})();
