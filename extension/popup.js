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

function placeOnMap() {
  const on = snap && snap.state.status === "on";
  if (!window.setBgTarget) return;
  if (!on) return window.setBgTarget(null);
  const c = geo || (serverCode() && window.CENTROIDS && window.CENTROIDS[serverCode()] && { lat: window.CENTROIDS[serverCode()][0], lon: window.CENTROIDS[serverCode()][1] });
  window.setBgTarget(c || null);
}

function serverCode() {
  const s = snap && snap.state.status === "on" ? snap.state.server : "";
  return (s && splitFlag(s).cc) || null;
}

function renderState(s) {
  document.body.className = s.status;
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
  placeOnMap();
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
  for (const k of ["killSwitch", "webrtc", "bypassLan", "autoConnect", "autoUpdate", "autoUpdateHost"]) $(k).checked = !!s[k];
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
      const r = await fetch("https://ipwho.is/?fields=success,ip,country_code,latitude,longitude", { cache: "no-store" });
      const j = await r.json();
      if (!j.success) throw new Error("geo");
      ip = j.ip;
      geo = { cc: String(j.country_code || "").toLowerCase(), lat: j.latitude, lon: j.longitude };
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
    for (const k of ["killSwitch", "webrtc", "bypassLan", "autoConnect", "autoUpdate", "autoUpdateHost"]) settings[k] = $(k).checked;
    snap = await send({ type: "saveSettings", settings });
  }, 400);
}
document.querySelectorAll("#settings input, #settings textarea, #autoConnect").forEach((el) => el.addEventListener("input", saveForm));

$("updList").addEventListener("click", async () => {
  const b = $("updList");
  b.disabled = true; $("listInfo").textContent = "Загрузка…";
  const r = await send({ type: "updateList" });
  b.disabled = false;
  if (r.ok) { snap.listInfo = r.listInfo; renderList(r.listInfo); } else $("listInfo").textContent = r.error;
});

const SETTING_KEYS = ["source", "mode", "include", "exclude", "listUrls", "autoUpdate", "killSwitch", "bypassLan", "webrtc", "autoConnect", "autoUpdateHost"];

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
    res.replaceChildren(...[["ПИНГ", out.ping], ["↓ МБИТ/С", out.down], ["↑ МБИТ/С", out.up]].map(([k, v]) => {
      const d = document.createElement("div");
      d.className = "card";
      const b = document.createElement("b");
      b.textContent = v;
      d.append(k, b);
      return d;
    }));
  };
  try {
    btn.textContent = "Пинг…"; show();
    const times = [];
    for (let i = 0; i < 10; i++) {
      const ms = await timed(() => fetch("https://speed.cloudflare.com/__down?bytes=0", { cache: "no-store" }).then((r) => r.arrayBuffer()));
      if (i > 0) times.push(ms);
    }
    times.sort((a, b) => a - b);
    out.ping = Math.round(times[Math.floor(times.length / 2)]) + " мс"; show();

    btn.textContent = "Загрузка…";
    const DOWN_MS = 12000, WARM_MS = 2000;
    const t0 = performance.now();
    let got = 0, warmAt = 0, warmGot = 0;
    const r = await fetch("https://speed.cloudflare.com/__down?bytes=400000000", { cache: "no-store" });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      const el = performance.now() - t0;
      if (!warmAt && el >= WARM_MS) { warmAt = el; warmGot = got; }
      if (warmAt && el - warmAt > 500) { out.down = (((got - warmGot) * 8) / 1e6 / ((el - warmAt) / 1000)).toFixed(1); show(); }
      if (el > DOWN_MS) { reader.cancel(); break; }
    }
    if (!warmAt) out.down = ((got * 8) / 1e6 / ((performance.now() - t0) / 1000)).toFixed(1);
    show();

    btn.textContent = "Отдача…";
    const UP_MS = 8000;
    const chunk = new Uint8Array(4 * 1024 * 1024);
    const u0 = performance.now();
    let sent = 0;
    while (performance.now() - u0 < UP_MS) {
      await fetch("https://speed.cloudflare.com/__up", { method: "POST", body: chunk, cache: "no-store" });
      sent += chunk.length;
      out.up = ((sent * 8) / 1e6 / ((performance.now() - u0) / 1000)).toFixed(1);
      show();
    }
  } catch (e) {
    const d = document.createElement("div");
    d.className = "card err";
    d.textContent = "Ошибка замера: " + String(e.message || e);
    res.replaceChildren(d);
  }
  btn.disabled = false;
  speedTesting = false;
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
