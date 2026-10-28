const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let snap = null;
let simpleOn = false;
try { simpleOn = localStorage.getItem("simple") === "1"; } catch {}
document.body.classList.toggle("simple", simpleOn);

function applySimple(on) {
  simpleOn = on;
  try { localStorage.setItem("simple", on ? "1" : "0"); } catch {}
  document.body.classList.toggle("simple", on);
  window.setBgEnabled?.(!on);
}

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

function splitFlag(name) {
  const m = String(name || "").match(/^\s*([\u{1F1E6}-\u{1F1FF}]{2})\s*(.*)$/u);
  if (!m) return { cc: null, text: name || "" };
  const cc = String.fromCharCode(...[...m[1]].map((c) => c.codePointAt(0) - 0x1f1e6 + 97));
  return { cc, text: m[2] };
}

document.querySelectorAll(".tab").forEach((b, i) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelector("nav").classList.toggle("s2", i === 1);
    if (i === 1) refreshLog();
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === b.dataset.tab));
  })
);

let shownServer = null;
let geo = null;

function flagImg(cc) {
  const img = document.createElement("img");
  img.className = cc ? "flag" : "flag none";
  if (cc) {
    img.src = `flags/${cc}.svg`;
    img.alt = cc.toUpperCase();
    img.onerror = () => img.classList.add("none");
  }
  return img;
}

function renderState(s) {
  document.body.className = s.status + (simpleOn ? " simple" : "");
  window.setBgMode?.(s.status);
  $("power").setAttribute("aria-label", s.status === "on" ? "Отключить" : "Подключить");
  if (!speedTesting) $("speedBtn").textContent = speedLabel(s.status);

  $("st").textContent =
    s.status === "on" ? "ЗАЩИЩЕНО" : s.status === "off" ? "ОТКЛЮЧЕНО" : s.status === "connecting" ? (s.message || "ПОДКЛЮЧЕНИЕ").toUpperCase() : s.message;

  const server = s.status === "on" ? s.server : "";
  const key = server + "|" + (geo ? geo.cc : "");
  if (key !== shownServer) {
    shownServer = key;
    const box = $("server");
    box.textContent = "";
    if (server) {
      const { cc, text } = splitFlag(server);
      const code = cc || (geo && geo.cc);
      if (code) box.append(flagImg(code));
      box.append(document.createTextNode(text));
    }
  }
  if (s.status === "on") loadIp(); else { ip = ""; ipLoaded = false; geo = null; }
  renderMeta();
}

function renderMeta() {
  if (!snap || snap.state.status !== "on") { $("meta").textContent = ""; return; }
  const t = snap.traffic.sessStart ? fmtDuration(Date.now() - snap.traffic.sessStart) : "";
  const h = snap.state.health;
  const ping = h ? (h.ok ? "пинг " + h.ms + " мс" : "⚠ нет интернета через VPN") : "";
  $("meta").textContent = [ip && "IP " + ip, t, ping].filter(Boolean).join("  ·  ");
  $("meta").classList.toggle("warn", !!(h && !h.ok));
}

function renderTraffic(t, sp) {
  $("down").textContent = fmtBytes(t.downTotal);
  $("up").textContent = fmtBytes(t.upTotal);
  $("sess").textContent = fmtBytes(t.downSess + t.upSess);
  const cur = speedTesting && live ? live : sp;
  const [d, du] = fmtRate(cur ? cur.down : 0);
  const [u, uu] = fmtRate(cur ? cur.up : 0);
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
  if (s.simpleView !== simpleOn) applySimple(!!s.simpleView);
  if (!force) return;
  for (const k of ["source", "include", "exclude", "listUrls"]) $(k).value = s[k] || "";
  for (const k of ["killSwitch", "webrtc", "bypassLan", "autoConnect", "autoUpdate", "autoUpdateHost", "simpleView"]) $(k).checked = !!s[k];
}

function renderList(info, local) {
  const when = info.updated ? new Date(info.updated).toLocaleString("ru-RU") : "встроенный снимок";
  $("listInfo").textContent = `${local || info.count} доменов · ${when}`;
}

function renderServers(s) {
  const list = s.servers || [];
  const box = $("serverBox");
  box.hidden = list.length < 2;
  if (box.hidden) return;
  const cur = s.settings.server || (s.state.status === "on" ? s.state.server : "") || list[0].name;
  const sig = list.map((x) => x.name).join("|") + "#" + cur;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const label = (x) => {
    const { cc, text } = splitFlag(x.name);
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = text;
    return [flagImg(cc), nm];
  };
  const curItem = list.find((x) => x.name === cur) || list[0];
  $("serverBtn").replaceChildren(...label(curItem));
  $("serverList").replaceChildren(...list.map((x) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(x.name === cur));
    const t = document.createElement("em");
    t.textContent = x.type;
    b.append(...label(x), t);
    b.addEventListener("click", () => pickServer(x.name));
    li.append(b);
    return li;
  }));
}

function toggleServers(open) {
  $("serverList").hidden = !open;
  $("serverBtn").setAttribute("aria-expanded", String(open));
}

async function pickServer(name) {
  toggleServers(false);
  snap = await send({ type: "saveSettings", settings: { server: name } });
  renderServers(snap);
  if (snap.state.status === "on" || snap.state.status === "connecting") render(await send({ type: "connect" }));
}

$("serverBtn").addEventListener("click", (e) => { e.stopPropagation(); toggleServers($("serverList").hidden); });
document.addEventListener("click", (e) => { if (!$("serverPick").contains(e.target)) toggleServers(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") toggleServers(false); });

let tab = null;

async function loadTab() {
  try {
    const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const u = new URL(t.url);
    tab = /^https?:$/.test(u.protocol) ? { id: t.id, host: u.hostname.replace(/^www\./, "").toLowerCase() } : null;
  } catch { tab = null; }
  renderSite();
}

const hostLines = (txt) => String(txt || "").split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);

function siteRule(s) {
  if (hostLines(s.exclude).includes(tab.host)) return "direct";
  if (hostLines(s.include).includes(tab.host)) return "vpn";
  return "auto";
}

function renderSite() {
  const box = $("siteBox");
  box.hidden = !tab || !snap;
  if (box.hidden) return;
  $("siteName").textContent = tab.host;
  $("siteName").title = tab.host;
  const r = siteRule(snap.settings);
  const btns = [...document.querySelectorAll("#siteSeg button")];
  btns.forEach((b) => b.classList.toggle("active", b.dataset.r === r));
  requestAnimationFrame(() => {
    const a = btns.find((b) => b.dataset.r === r);
    const ink = document.querySelector(".seg3-ink");
    ink.style.left = a.offsetLeft + "px";
    ink.style.width = a.offsetWidth + "px";
  });
}

document.querySelectorAll("#siteSeg button").forEach((b) =>
  b.addEventListener("click", async () => {
    const s = snap.settings;
    const strip = (txt) => String(txt || "").split(/\r?\n/).filter((l) => l.trim().toLowerCase() !== tab.host).join("\n").trim();
    let include = strip(s.include), exclude = strip(s.exclude);
    if (b.dataset.r === "vpn") include = (include ? include + "\n" : "") + tab.host;
    if (b.dataset.r === "direct") exclude = (exclude ? exclude + "\n" : "") + tab.host;
    snap = await send({ type: "saveSettings", settings: { include, exclude } });
    $("include").value = snap.settings.include;
    $("exclude").value = snap.settings.exclude;
    renderSite();
    chrome.tabs.reload(tab.id);
  })
);

const logTime = (t) => new Date(t).toLocaleTimeString("ru-RU");

async function refreshLog() {
  const entries = await send({ type: "getLog" });
  const v = $("logView");
  v.value = entries.slice(-80).map((e) => logTime(e.t) + "  " + e.m).join("\n");
  v.scrollTop = v.scrollHeight;
}

$("logRefresh").addEventListener("click", refreshLog);
$("logClear").addEventListener("click", async () => {
  await send({ type: "clearLog" });
  $("logView").value = "";
});
$("logExport").addEventListener("click", async () => {
  const entries = await send({ type: "getLog" });
  const s = snap.settings;
  const head = [
    "VPN Terminal " + chrome.runtime.getManifest().version,
    navigator.userAgent,
    "Статус: " + snap.state.status,
    `Режим: ${s.mode}; kill-switch: ${s.killSwitch}; автоподключение: ${s.autoConnect}`,
    "Серверов в подписке: " + (snap.servers || []).length,
    "Выгружено: " + new Date().toISOString(),
    "",
  ];
  const text = head.concat(entries.map((e) => new Date(e.t).toISOString() + "  " + e.m)).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = "vpn-terminal-log-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".txt";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

function render(s, force) {
  snap = s;
  renderServers(s);
  renderSite();
  renderState(s.state);
  renderTraffic(s.traffic, s.speed);
  renderSettings(s.settings, force);
  renderList(s.listInfo, s.listLocal);
}

const gcv = $("graph");
const gctx = gcv.getContext("2d");
(() => { const dpr = Math.min(devicePixelRatio || 1, 2); gcv.width = gcv.clientWidth * dpr; gcv.height = gcv.clientHeight * dpr; gctx.scale(dpr, dpr); })();

function drawGraph(hist) {
  const W = gcv.clientWidth, H = gcv.clientHeight, N = 60;
  const cs = getComputedStyle(document.body);
  const g = cs.getPropertyValue("--g").trim(), rgb = cs.getPropertyValue("--rgb").trim();
  gctx.clearRect(0, 0, W, H);
  gctx.strokeStyle = `rgba(${rgb},.1)`; gctx.lineWidth = 1;
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
      gr.addColorStop(0, fill); gr.addColorStop(1, `rgba(${rgb},0)`);
      gctx.fillStyle = gr; gctx.fill();
      gctx.restore();
      gctx.beginPath();
      hist.forEach((h, i) => (i ? gctx.lineTo(x(i), y(h[k])) : gctx.moveTo(x(i), y(h[k]))));
    }
    gctx.strokeStyle = stroke; gctx.lineWidth = 1.6; gctx.lineJoin = "round"; gctx.stroke();
  };
  line(0, g, `rgba(${rgb},.28)`);
  line(1, "rgba(46,230,255,.85)");
  const lx = x(hist.length - 1), ly = y(hist[hist.length - 1][0]);
  gctx.fillStyle = g; gctx.beginPath(); gctx.arc(lx - 1, ly, 2.5, 0, 6.29); gctx.fill();
}

let ip = "", ipLoaded = false;
async function loadIp() {
  if (ipLoaded) return;
  ipLoaded = true;
  try {
    try {
      const r = await fetch("https://ipwho.is/?fields=success,ip,country_code", { cache: "no-store" });
      const j = await r.json();
      if (!j.success) throw new Error("geo");
      ip = j.ip;
      geo = { cc: String(j.country_code || "").toLowerCase() };
    } catch {
      const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
      ip = (await r.json()).ip;
    }
    renderMeta();
    if (snap) renderState(snap.state);
  } catch { ipLoaded = false; }
}

$("power").addEventListener("click", async () => {
  ipLoaded = false; ip = ""; geo = null;
  const on = snap.state.status === "on" || snap.state.status === "connecting";
  render(await send({ type: on ? "disconnect" : "connect" }));
});

document.querySelectorAll("#modeSeg button").forEach((b) =>
  b.addEventListener("click", async () => {
    setSeg(b.dataset.mode);
    ipLoaded = false; geo = null;
    render(await send({ type: "saveSettings", settings: { mode: b.dataset.mode } }));
  })
);

let saveTimer;
function saveForm() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const settings = {};
    for (const k of ["source", "include", "exclude", "listUrls"]) settings[k] = $(k).value.trim();
    for (const k of ["killSwitch", "webrtc", "bypassLan", "autoConnect", "autoUpdate", "autoUpdateHost", "simpleView"]) settings[k] = $(k).checked;
    snap = await send({ type: "saveSettings", settings });
  }, 400);
}
document.querySelectorAll("#settings input, #settings textarea, #autoConnect").forEach((el) => el.addEventListener("input", saveForm));
$("simpleView").addEventListener("change", () => applySimple($("simpleView").checked));

$("updList").addEventListener("click", async () => {
  const b = $("updList");
  b.disabled = true; $("listInfo").textContent = "Загрузка…";
  const r = await send({ type: "updateList" });
  b.disabled = false;
  if (r.ok) { snap.listInfo = r.listInfo; renderList(r.listInfo); } else $("listInfo").textContent = r.error;
});

const SETTING_KEYS = ["source", "mode", "include", "exclude", "listUrls", "autoUpdate", "killSwitch", "bypassLan", "webrtc", "autoConnect", "autoUpdateHost", "simpleView"];

$("cfgExport").addEventListener("click", () => {
  const settings = {};
  for (const k of SETTING_KEYS) settings[k] = snap.settings[k];
  const data = { app: "vpn-terminal", version: chrome.runtime.getManifest().version, exported: new Date().toISOString(), settings };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = "vpn-terminal-settings.json";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$("cfgImport").addEventListener("click", () => $("cfgFile").click());
$("cfgFile").addEventListener("change", async () => {
  const f = $("cfgFile").files[0];
  $("cfgFile").value = "";
  if (!f) return;
  const info = $("cfgInfo");
  try {
    if (f.size > 200 * 1024) throw new Error("файл слишком большой");
    const data = JSON.parse(await f.text());
    if (!data || data.app !== "vpn-terminal" || typeof data.settings !== "object" || !data.settings) throw new Error("это не файл настроек VPN Terminal");
    const patch = {};
    for (const k of SETTING_KEYS) if (k in data.settings) patch[k] = data.settings[k];
    render(await send({ type: "saveSettings", settings: patch }), true);
    info.textContent = "Настройки импортированы.";
  } catch (e) {
    info.textContent = "Не удалось импортировать: " + (e.message || e);
  }
});

const hostBtn = $("hostCheck");
let hostNewer = null;

function showHostUpdate(u) {
  if (!u) return;
  if (u.error) { $("hostInfo").textContent = u.error; return; }
  hostNewer = u.newer ? u.latest : null;
  $("hostInfo").textContent = u.newer ? `Доступна ${u.latest}, установлена ${u.current}` : `Версия ${u.current}, обновлений нет`;
  hostBtn.textContent = u.newer ? "Обновить" : "Проверить";
}

hostBtn.addEventListener("click", async () => {
  hostBtn.disabled = true;
  $("hostInfo").textContent = hostNewer ? "Обновление…" : "Проверка…";
  const r = hostNewer ? await send({ type: "applyHostUpdate" }) : await send({ type: "checkHostUpdate" });
  hostBtn.disabled = false;
  if (!r.ok) { $("hostInfo").textContent = r.error; return; }
  if (hostNewer) {
    $("hostInfo").textContent = r.changed ? `Обновлено до ${r.version}, расширение перезапускается` : "Установлена последняя версия";
    hostNewer = null;
    hostBtn.textContent = "Проверить";
    return;
  }
  showHostUpdate(r);
});

chrome.storage.local.get("hostUpdate").then(({ hostUpdate }) => showHostUpdate(hostUpdate));

$("resetTraffic").addEventListener("click", async () => render(await send({ type: "resetTraffic" })));

let speedTesting = false;
let live = null;
function speedLabel(status) {
  return "Замерить скорость " + (status === "on" ? "(через VPN)" : "(без VPN)");
}

async function timed(fn) { const t = performance.now(); await fn(); return performance.now() - t; }

const SPEED_HOST = "https://speed.cloudflare.com";

function meter(onLive, key) {
  let bytes = 0, lastB = 0, lastT = performance.now(), warmAt = 0, warmB = 0;
  const t0 = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    live = { ...(live || { down: 0, up: 0 }), [key]: ((bytes - lastB) * 1000) / (now - lastT) };
    lastB = bytes; lastT = now;
    if (!warmAt && now - t0 >= 1500) { warmAt = now; warmB = bytes; }
    onLive(warmAt && now - warmAt > 600 ? (((bytes - warmB) * 8) / 1e6) / ((now - warmAt) / 1000) : null);
    renderTraffic(snap.traffic, snap.speed);
  }, 250);
  return {
    add(n) { bytes += n; },
    done() {
      clearInterval(tick);
      const now = performance.now();
      live = { ...(live || { down: 0, up: 0 }), [key]: 0 };
      if (warmAt && now - warmAt > 600) return (((bytes - warmB) * 8) / 1e6) / ((now - warmAt) / 1000);
      return bytes ? ((bytes * 8) / 1e6) / ((now - t0) / 1000) : 0;
    },
  };
}

async function measureDown(ms, onLive) {
  const m = meter(onLive, "down");
  const end = performance.now() + ms;
  let failure = null;
  const worker = async () => {
    while (performance.now() < end && !failure) {
      const r = await fetch(`${SPEED_HOST}/__down?bytes=25000000&r=${Math.random()}`, { cache: "no-store" });
      if (!r.ok) { failure = new Error("HTTP " + r.status); return; }
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        m.add(value.length);
        if (performance.now() >= end) { rd.cancel(); return; }
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()].map((p) => p.catch((e) => { failure = failure || e; })));
  const v = m.done();
  if (failure && !v) throw failure;
  return v;
}

function postChunk(body, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    let last = 0;
    x.open("POST", `${SPEED_HOST}/__up`);
    x.upload.onprogress = (e) => { onProgress(e.loaded - last); last = e.loaded; };
    x.onload = () => { onProgress(body.length - last); resolve(); };
    x.onerror = () => reject(new Error("сеть недоступна"));
    x.send(body);
  });
}

async function measureUp(ms, onLive) {
  const m = meter(onLive, "up");
  const end = performance.now() + ms;
  const chunk = new Uint8Array(2 * 1024 * 1024);
  let failure = null;
  const worker = async () => {
    while (performance.now() < end && !failure) await postChunk(chunk, (n) => m.add(n));
  };
  await Promise.all([worker(), worker(), worker()].map((p) => p.catch((e) => { failure = failure || e; })));
  const v = m.done();
  if (failure && !v) throw failure;
  return v;
}

async function speedTest() {
  const btn = $("speedBtn"), res = $("speedRes");
  btn.disabled = true;
  speedTesting = true;
  live = { down: 0, up: 0 };
  const out = { ping: "—", down: "—", up: "—" };
  const show = () => {
    res.replaceChildren(...[["ПИНГ", out.ping], ["↓ МБИТ/С", out.down], ["↑ МБИТ/С", out.up]].map(([k, v]) => {
      const d = document.createElement("div");
      d.className = "card";
      const b = document.createElement("b");
      b.textContent = v;
      d.append(k, b);
      return d;
    }));
  };
  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  try {
    btn.textContent = "Пинг…"; show();
    const times = [];
    for (let i = 0; i < 10; i++) {
      const ms = await timed(() => fetch(`${SPEED_HOST}/__down?bytes=0&r=${Math.random()}`, { cache: "no-store" }).then((r) => r.arrayBuffer()));
      if (i > 0) times.push(ms);
    }
    times.sort((a, b) => a - b);
    out.ping = Math.round(times[Math.floor(times.length / 2)]) + " мс"; show();

    btn.textContent = "Загрузка…";
    out.down = fmt(await measureDown(10000, (v) => { if (v) { out.down = fmt(v); show(); } })); show();

    btn.textContent = "Отдача…";
    out.up = fmt(await measureUp(8000, (v) => { if (v) { out.up = fmt(v); show(); } })); show();
  } catch (e) {
    const d = document.createElement("div");
    d.className = "card err";
    d.textContent = "Ошибка замера: " + String(e.message || e);
    res.replaceChildren(d);
  }
  btn.disabled = false;
  speedTesting = false;
  live = null;
  btn.textContent = speedLabel(snap.state.status);
}
$("speedBtn").addEventListener("click", speedTest);

chrome.runtime.onMessage.addListener((m) => {
  if (m.type === "state" && snap) { snap.state = m.state; renderState(m.state); }
  if (m.type === "hostProgress") $("hostInfo").textContent = m.message;
});

send({ type: "getState" }).then(async (s) => {
  render(s, true);
  await loadTab();
  setInterval(async () => {
    if (document.hidden) return;
    const r = await send({ type: "getState" });
    snap.traffic = r.traffic; snap.speed = r.speed; snap.servers = r.servers;
    renderServers(snap);
    renderTraffic(r.traffic, r.speed);
    renderMeta();
  }, 500);
});

(() => {
  const el = document.getElementById("lensMap");
  if (!el) return;
  const N = 192, c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d"), img = g.createImageData(N, N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = ((i + 0.5) / N) * 2 - 1, v = ((j + 0.5) / N) * 2 - 1;
      const r2 = u * u + v * v;
      const k = r2 >= 1 ? 0 : (1 - r2) * (1 - r2);
      const o = (j * N + i) * 4;
      img.data[o] = Math.round(127.5 - 127.5 * u * k);
      img.data[o + 1] = Math.round(127.5 - 127.5 * v * k);
      img.data[o + 2] = 128;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  el.setAttribute("href", c.toDataURL("image/png"));
})();
