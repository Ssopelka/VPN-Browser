const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let snap = null;

function fmtBytes(n) {
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 2 : 1)) + " " + u[i];
}

function fmtRate(bytesPerSec) {
  const bits = bytesPerSec * 8;
  if (bits >= 1e6) return [(bits / 1e6).toFixed(bits >= 1e8 ? 0 : 1), "Мбит/с"];
  return [Math.round(bits / 1e3).toString(), "Кбит/с"];
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0");
}

// "🇩🇪 Германия" -> { cc: "de", text: "Германия" }. Windows не рисует эмодзи-флаги, поэтому берём SVG.
function splitFlag(name) {
  const m = String(name || "").match(/^\s*([\u{1F1E6}-\u{1F1FF}]{2})\s*(.*)$/u);
  if (!m) return { cc: null, text: name || "" };
  const cc = String.fromCharCode(...[...m[1]].map((c) => c.codePointAt(0) - 0x1f1e6 + 97));
  return { cc, text: m[2] };
}

// ---------- вкладки ----------
document.querySelectorAll(".tab").forEach((b, i) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelector("nav").classList.toggle("s2", i === 1);
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === b.dataset.tab));
  })
);

// ---------- отрисовка ----------
const PILL = { on: "ОНЛАЙН", connecting: "ПОДКЛЮЧЕНИЕ", error: "ОШИБКА", off: "ОФФЛАЙН" };
let shownServer = null;

function renderState(s) {
  document.body.className = s.status;
  window.setBgMode?.(s.status);
  $("pill").querySelector("span").textContent = PILL[s.status] || PILL.off;
  $("power").setAttribute("aria-label", s.status === "on" ? "Отключить" : "Подключить");
  if (!speedTesting) $("speedBtn").textContent = speedLabel(s.status);

  $("st").textContent =
    s.status === "on" ? "ЗАЩИЩЕНО" : s.status === "off" ? "ОТКЛЮЧЕНО" : s.status === "connecting" ? (s.message || "ПОДКЛЮЧЕНИЕ").toUpperCase() : s.message;

  const server = s.status === "on" ? s.server : "";
  if (server !== shownServer) {
    shownServer = server;
    const box = $("server");
    box.textContent = "";
    if (server) {
      const { cc, text } = splitFlag(server);
      if (cc) {
        const img = document.createElement("img");
        img.src = `flags/${cc}.svg`;
        img.alt = cc.toUpperCase();
        img.onerror = () => img.remove();
        box.append(img);
      }
      box.append(document.createTextNode(text));
    }
  }
  if (s.status === "on") loadIp(); else { ip = ""; ipLoaded = false; }
  renderMeta();
}

function renderMeta() {
  if (!snap || snap.state.status !== "on") { $("meta").textContent = ""; return; }
  const t = snap.traffic.sessStart ? fmtDuration(Date.now() - snap.traffic.sessStart) : "";
  $("meta").textContent = [ip && "IP " + ip, t].filter(Boolean).join("  ·  ");
}

function renderTraffic(t, sp) {
  $("down").textContent = fmtBytes(t.downTotal);
  $("up").textContent = fmtBytes(t.upTotal);
  $("sess").textContent = fmtBytes(t.downSess + t.upSess);
  const [d, du] = fmtRate(sp ? sp.down : 0);
  const [u, uu] = fmtRate(sp ? sp.up : 0);
  $("spdDown").textContent = d; $("spdDownU").textContent = du;
  $("spdUp").textContent = u; $("spdUpU").textContent = uu;
  drawGraph(sp ? sp.hist : []);
}

function setSeg(mode) {
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("modeSeg").classList.toggle("s2", mode === "blocked");
}

function renderSettings(s, force) {
  setSeg(s.mode);
  if (!force) return;
  for (const k of ["source", "include", "exclude", "listUrls"]) $(k).value = s[k] || "";
  for (const k of ["killSwitch", "webrtc", "bypassLan", "autoConnect", "autoUpdate"]) $(k).checked = !!s[k];
}

function renderList(info, local) {
  const when = info.updated ? new Date(info.updated).toLocaleString("ru-RU") : "встроенный снимок";
  $("listInfo").textContent = `${local || info.count} доменов · ${when}`;
}

function render(s, force) {
  snap = s;
  renderState(s.state);
  renderTraffic(s.traffic, s.speed);
  renderSettings(s.settings, force);
  renderList(s.listInfo, s.listLocal);
}

// ---------- график скорости ----------
const gcv = $("graph");
const gctx = gcv.getContext("2d");
(() => { const dpr = Math.min(devicePixelRatio || 1, 2); gcv.width = gcv.clientWidth * dpr; gcv.height = gcv.clientHeight * dpr; gctx.scale(dpr, dpr); })();

function drawGraph(hist) {
  const W = gcv.clientWidth, H = gcv.clientHeight, N = 60;
  gctx.clearRect(0, 0, W, H);
  gctx.strokeStyle = "rgba(0,255,102,.08)"; gctx.lineWidth = 1;
  gctx.beginPath();
  for (let i = 1; i < 4; i++) { const y = Math.round((H * i) / 4) + 0.5; gctx.moveTo(0, y); gctx.lineTo(W, y); }
  gctx.stroke();
  if (!hist.length) return;
  const max = Math.max(64 * 1024, ...hist.map((h) => Math.max(h[0], h[1]))) * 1.15;
  const x = (i) => W - (hist.length - 1 - i) * (W / (N - 1));
  const y = (v) => H - 2 - (v / max) * (H - 6);

  const line = (k, stroke, fill) => {
    gctx.beginPath();
    hist.forEach((h, i) => (i ? gctx.lineTo(x(i), y(h[k])) : gctx.moveTo(x(i), y(h[k]))));
    if (fill) {
      gctx.save();
      gctx.lineTo(x(hist.length - 1), H); gctx.lineTo(x(0), H); gctx.closePath();
      const gr = gctx.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, fill); gr.addColorStop(1, "rgba(0,255,102,0)");
      gctx.fillStyle = gr; gctx.fill();
      gctx.restore();
      gctx.beginPath();
      hist.forEach((h, i) => (i ? gctx.lineTo(x(i), y(h[k])) : gctx.moveTo(x(i), y(h[k]))));
    }
    gctx.strokeStyle = stroke; gctx.lineWidth = 1.6; gctx.lineJoin = "round"; gctx.stroke();
  };
  line(0, "#00ff66", "rgba(0,255,102,.28)");
  line(1, "rgba(46,230,255,.85)");
  const lx = x(hist.length - 1), ly = y(hist[hist.length - 1][0]);
  gctx.fillStyle = "#00ff66"; gctx.beginPath(); gctx.arc(lx - 1, ly, 2.5, 0, 6.29); gctx.fill();
}

// ---------- IP ----------
let ip = "", ipLoaded = false;
async function loadIp() {
  if (ipLoaded) return;
  ipLoaded = true;
  try {
    const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    ip = (await r.json()).ip;
    renderMeta();
  } catch { ipLoaded = false; }
}

// ---------- действия ----------
$("power").addEventListener("click", async () => {
  ipLoaded = false; ip = "";
  const on = snap.state.status === "on" || snap.state.status === "connecting";
  render(await send({ type: on ? "disconnect" : "connect" }));
});

document.querySelectorAll("#modeSeg button").forEach((b) =>
  b.addEventListener("click", async () => {
    setSeg(b.dataset.mode);
    ipLoaded = false;
    render(await send({ type: "saveSettings", settings: { mode: b.dataset.mode } }));
  })
);

let saveTimer;
function saveForm() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const settings = {};
    for (const k of ["source", "include", "exclude", "listUrls"]) settings[k] = $(k).value.trim();
    for (const k of ["killSwitch", "webrtc", "bypassLan", "autoConnect", "autoUpdate"]) settings[k] = $(k).checked;
    snap = await send({ type: "saveSettings", settings });
  }, 400);
}
document.querySelectorAll("#settings input, #settings textarea").forEach((el) => el.addEventListener("input", saveForm));

$("updList").addEventListener("click", async () => {
  const b = $("updList");
  b.disabled = true; $("listInfo").textContent = "Загрузка…";
  const r = await send({ type: "updateList" });
  b.disabled = false;
  if (r.ok) { snap.listInfo = r.listInfo; renderList(r.listInfo); } else $("listInfo").textContent = r.error;
});

$("resetTraffic").addEventListener("click", async () => render(await send({ type: "resetTraffic" })));

// ---------- замер скорости (Cloudflare; в режиме «блокировки» этот домен принудительно идёт через VPN) ----------
let speedTesting = false;
function speedLabel(status) {
  return "Замерить скорость " + (status === "on" ? "(через VPN)" : "(без VPN)");
}

async function timed(fn) { const t = performance.now(); await fn(); return performance.now() - t; }

async function speedTest() {
  const btn = $("speedBtn"), res = $("speedRes");
  btn.disabled = true;
  speedTesting = true;
  const out = { ping: "—", down: "—", up: "—" };
  const show = () => {
    res.innerHTML = `<div class="card">ПИНГ<b>${out.ping}</b></div><div class="card">↓ МБИТ/С<b>${out.down}</b></div><div class="card">↑ МБИТ/С<b>${out.up}</b></div>`;
  };
  try {
    btn.textContent = "Пинг…"; show();
    const times = [];
    for (let i = 0; i < 6; i++) {
      const ms = await timed(() => fetch("https://speed.cloudflare.com/__down?bytes=0", { cache: "no-store" }).then((r) => r.arrayBuffer()));
      if (i > 0) times.push(ms); // первый запрос включает установку соединения
    }
    times.sort((a, b) => a - b);
    out.ping = Math.round(times[Math.floor(times.length / 2)]) + " мс"; show();

    btn.textContent = "Загрузка…";
    const t0 = performance.now();
    let got = 0;
    const r = await fetch("https://speed.cloudflare.com/__down?bytes=40000000", { cache: "no-store" });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      const sec = (performance.now() - t0) / 1000;
      if (sec > 0.3) { out.down = ((got * 8) / 1e6 / sec).toFixed(1); show(); }
      if (sec > 8) { reader.cancel(); break; }
    }

    btn.textContent = "Отдача…";
    const body = new Uint8Array(8 * 1024 * 1024);
    const ms = await timed(() => fetch("https://speed.cloudflare.com/__up", { method: "POST", body, cache: "no-store" }));
    out.up = ((body.length * 8) / 1e6 / (ms / 1000)).toFixed(1); show();
  } catch (e) {
    res.innerHTML = `<div class="card err">Ошибка замера: ${String(e.message || e)}</div>`;
  }
  btn.disabled = false;
  speedTesting = false;
  btn.textContent = speedLabel(snap.state.status);
}
$("speedBtn").addEventListener("click", speedTest);

// ---------- старт ----------
chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "state" && snap) { snap.state = m.state; renderState(m.state); }
});

send({ type: "getState" }).then((s) => {
  render(s, true);
  setInterval(async () => {
    if (document.hidden) return;
    const r = await send({ type: "getState" });
    snap.traffic = r.traffic; snap.speed = r.speed;
    renderTraffic(r.traffic, r.speed);
    renderMeta();
  }, 500);
});
