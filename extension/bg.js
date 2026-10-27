// Фон: светящиеся шарики-узлы, соединённые линиями (P2P-сеть).
// Дёшево: 30 fps, свечение заранее отрисовано в спрайт (без shadowBlur/filter), пауза когда окно скрыто.
(() => {
  const cv = document.getElementById("bg");
  const ctx = cv.getContext("2d", { alpha: false });
  const DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  const FPS = 30;
  const LINK = 92;
  let W = 0, H = 0, nodes = [], last = 0, raf = 0;
  let mode = "off"; // off | on | connecting | error
  const mouse = { x: -999, y: -999 };

  const COLORS = { off: [0, 200, 90], on: [0, 255, 102], connecting: [255, 212, 0], error: [255, 59, 78] };
  let col = [...COLORS.off];

  // спрайт свечения: один раз на смену цвета
  const sprite = document.createElement("canvas");
  function paintSprite() {
    const s = 64; sprite.width = sprite.height = s;
    const g = sprite.getContext("2d");
    const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    const [r, gg, b] = col.map(Math.round);
    grd.addColorStop(0, `rgba(${r},${gg},${b},1)`);
    grd.addColorStop(0.18, `rgba(${r},${gg},${b},.55)`);
    grd.addColorStop(0.5, `rgba(${r},${gg},${b},.12)`);
    grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.clearRect(0, 0, s, s); g.fillStyle = grd; g.fillRect(0, 0, s, s);
  }

  function resize() {
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function seed() {
    nodes = [];
    for (let i = 0; i < 26; i++) {
      const z = Math.random(); // глубина: дальние меньше, тусклее и медленнее
      nodes.push({
        x: Math.random() * W, y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.25, vy: -(0.08 + Math.random() * 0.25),
        z, r: 6 + z * 22, ph: Math.random() * 6.28,
      });
    }
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < 1000 / FPS) return;
    const dt = Math.min(3, (t - last) / (1000 / 60));
    last = t;

    // плавная смена цвета
    const tgt = COLORS[mode] || COLORS.off;
    let changed = false;
    for (let i = 0; i < 3; i++) { const d = tgt[i] - col[i]; if (Math.abs(d) > 0.5) { col[i] += d * 0.08; changed = true; } }
    if (changed) paintSprite();
    const [r, g, b] = col.map(Math.round);

    const speedK = mode === "on" ? 1.9 : mode === "connecting" ? 3 : 1;

    ctx.fillStyle = "#030604";
    ctx.fillRect(0, 0, W, H);

    // сетка-горизонт снизу
    ctx.strokeStyle = `rgba(${r},${g},${b},.05)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 24) { ctx.moveTo(x + 0.5, H * 0.62); ctx.lineTo(x + 0.5, H); }
    const off = (t / 60) % 24;
    for (let y = H * 0.62 + off; y < H; y += 24) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();

    for (const n of nodes) {
      n.ph += 0.01 * dt;
      n.x += (n.vx + Math.sin(n.ph) * 0.12) * dt * speedK * (0.4 + n.z);
      n.y += n.vy * dt * speedK * (0.4 + n.z);
      // лёгкое отталкивание от курсора
      const mx = n.x - mouse.x, my = n.y - mouse.y, md = mx * mx + my * my;
      if (md < 4900) { n.x += (mx / 70) * dt; n.y += (my / 70) * dt; }
      if (n.y < -40) { n.y = H + 40; n.x = Math.random() * W; }
      if (n.x < -40) n.x = W + 40; else if (n.x > W + 40) n.x = -40;
    }

    // линии между близкими узлами
    ctx.lineWidth = 1;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const c = nodes[j];
        const dx = a.x - c.x, dy = a.y - c.y, d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          const al = (1 - Math.sqrt(d2) / LINK) * 0.22 * (0.4 + Math.min(a.z, c.z));
          ctx.strokeStyle = `rgba(${r},${g},${b},${al.toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
        }
      }
    }

    // шарики
    for (const n of nodes) {
      const s = n.r * (1 + Math.sin(n.ph * 2) * 0.08) * 2;
      ctx.globalAlpha = 0.18 + n.z * 0.5;
      ctx.drawImage(sprite, n.x - s / 2, n.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }

  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }

  resize(); paintSprite(); seed();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { frame(1e9); stop(); }
  else start();

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  addEventListener("mouseleave", () => { mouse.x = mouse.y = -999; });

  window.setBgMode = (m) => { mode = m; };
})();
