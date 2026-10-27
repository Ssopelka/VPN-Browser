const HOST = "net.stealthsurf.vpn_host";
// Порт, который никто не слушает: проксируемые запросы падают, а не уходят напрямую.
const DEAD = "PROXY 127.0.0.1:1";
const RETRY_MS = [2000, 5000, 15000];
const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_STR = 20000;
const DAY = 24 * 3600 * 1000;
const LOG_MAX = 400;

const DEFAULTS = {
  source: "",
  server: "",
  mode: "all",
  include: "",
  exclude: "",
  listUrls: [
    "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/inside-raw.lst",
    "https://community.antifilter.download/list/domains.lst",
  ].join("\n"),
  autoUpdate: true,
  killSwitch: true,
  bypassLan: true,
  webrtc: true,
  autoConnect: false,
};
const ALWAYS_PROXY = ["speed.cloudflare.com", "api.ipify.org"];

let settings = { ...DEFAULTS };
let state = { status: "off", message: "", server: "" };
let endpoint = "";
let traffic = { downTotal: 0, upTotal: 0, downSess: 0, upSess: 0, sessStart: 0 };
let listInfo = { count: 0, updated: 0 };
let sets = { blocked: new Set(), include: new Set(), exclude: new Set(), always: new Set(ALWAYS_PROXY) };
let port = null;
let reconnects = 0;
let reconnectTimer = null;
let servers = [];
let logBuf = [];
let logTimer = null;
let listTimer = null;

const redact = (s) =>
  String(s)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, (m) => m.split("://")[0] + "://…")
    .replace(/\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "x.x.x.x");

function log(text) {
  logBuf.push({ t: Date.now(), m: redact(text) });
  if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => chrome.storage.local.set({ log: logBuf }), 1500);
}

const SCHEMA = {
  source: "string", server: "string", mode: ["all", "blocked"], include: "string", exclude: "string", listUrls: "string",
  autoUpdate: "boolean", killSwitch: "boolean", bypassLan: "boolean", webrtc: "boolean", autoConnect: "boolean",
};
function sanitize(patch) {
  const out = {};
  for (const [k, t] of Object.entries(SCHEMA)) {
    const v = patch && Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : undefined;
    if (v === undefined) continue;
    if (Array.isArray(t) ? t.includes(v) : typeof v === t && (t !== "string" || v.length <= MAX_STR)) out[k] = v;
  }
  return out;
}

const boot = (async () => {
  const [l, s] = await Promise.all([
    chrome.storage.local.get(["settings", "url", "traffic", "blocked", "listInfo", "servers", "log"]),
    chrome.storage.session.get(["state", "endpoint"]),
  ]);
  settings = { ...DEFAULTS, ...(l.settings || {}) };
  if (!l.settings && l.url) settings.source = l.url;
  if (l.traffic) traffic = { ...traffic, ...l.traffic };
  if (s.state) state = s.state;
  if (s.endpoint) endpoint = s.endpoint;
  if (l.listInfo) listInfo = l.listInfo;
  if (Array.isArray(l.servers)) servers = l.servers;
  if (Array.isArray(l.log)) logBuf = l.log;
  let blocked = l.blocked;
  if (!blocked) blocked = await loadBundled();
  rebuildSets(blocked);
  if (state.status === "on") startTick();
})();

async function loadBundled() {
  const txt = await (await fetch(chrome.runtime.getURL("data/blocked.txt"))).text();
  const list = parseDomains(txt);
  listInfo = { count: list.length, updated: 0 };
  await chrome.storage.local.set({ blocked: list, listInfo });
  return list;
}

function parseDomains(text) {
  const out = new Set();
  for (let line of String(text).split(/\r?\n/)) {
    line = line.trim().toLowerCase();
    if (!line || line[0] === "#" || line.startsWith("//")) continue;
    line = line.replace(/^(domain|full):/, "").replace(/^\*\./, "").replace(/^\./, "");
    if (/^[a-z0-9.-]+$/.test(line) && !line.includes("..") && !/^[.-]|[.-]$/.test(line)) out.add(line);
  }
  return [...out];
}

function rebuildSets(blockedList) {
  if (blockedList) sets.blocked = new Set(blockedList);
  sets.include = new Set(parseDomains(settings.include));
  sets.exclude = new Set(parseDomains(settings.exclude));
}

function inSet(set, host) {
  for (;;) {
    if (set.has(host)) return true;
    const i = host.indexOf(".");
    if (i < 0) return false;
    host = host.slice(i + 1);
  }
}

function shouldProxy(host) {
  if (inSet(sets.exclude, host)) return false;
  if (settings.mode === "all") return true;
  return inSet(sets.always, host) || inSet(sets.include, host) || inSet(sets.blocked, host);
}

function persistState() {
  chrome.storage.session.set({ state, endpoint });
}

function setState(patch) {
  if (patch.status && patch.status !== state.status) {
    log("Статус: " + patch.status + (patch.message ? " — " + patch.message : ""));
  }
  state = { ...state, ...patch };
  persistState();
  chrome.action.setBadgeText({ text: state.status === "on" ? "ON" : state.status === "connecting" ? "…" : "" });
  chrome.action.setBadgeBackgroundColor({ color: state.status === "on" ? "#0a0" : "#888" });
  chrome.runtime.sendMessage({ type: "state", state }).catch(() => {});
}

function buildPac() {
  const q = (set) => JSON.stringify([...set]);
  const route = endpoint + (settings.killSwitch ? "" : "; DIRECT");
  return `
var P = ${JSON.stringify(route)};
function mk(a){var o={};for(var i=0;i<a.length;i++)o[a[i]]=1;return o;}
var EX = mk(${q(sets.exclude)});
var IN = mk(${q(new Set([...sets.include, ...sets.always]))});
var BL = mk(${settings.mode === "blocked" ? q(sets.blocked) : "[]"});
var ALL = ${settings.mode === "all"};
function has(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
function walk(o,h){for(;;){if(has(o,h))return true;var i=h.indexOf(".");if(i<0)return false;h=h.slice(i+1);}}
function FindProxyForURL(url,host){
  host=host.toLowerCase();
  if(isPlainHostName(host)||host==="localhost")return "DIRECT";
  ${settings.bypassLan ? `if(/^[0-9.]+$/.test(host)&&(isInNet(host,"10.0.0.0","255.0.0.0")||isInNet(host,"172.16.0.0","255.240.0.0")||isInNet(host,"192.168.0.0","255.255.0.0")||isInNet(host,"127.0.0.0","255.0.0.0")||isInNet(host,"169.254.0.0","255.255.0.0")))return "DIRECT";` : ""}
  if(walk(EX,host))return "DIRECT";
  if(ALL||walk(IN,host)||walk(BL,host))return P;
  return "DIRECT";
}`;
}

async function applyProxy() {
  if (!endpoint || (state.status !== "on" && endpoint !== DEAD)) return;
  await chrome.proxy.settings.set({
    scope: "regular",
    value: { mode: "pac_script", pacScript: { data: buildPac(), mandatory: true } },
  });
  try {
    if (settings.webrtc) await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
    else await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  } catch {}
}

async function clearProxy() {
  stopTick();
  await chrome.proxy.settings.clear({ scope: "regular" });
  try { await chrome.privacy.network.webRTCIPHandlingPolicy.clear({}); } catch {}
}

function parseDirect(input) {
  let u;
  try { u = new URL(input); } catch { return null; }
  const scheme = u.protocol.slice(0, -1);
  const bare = (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
  const isProxy = ["socks5", "socks4", "socks"].includes(scheme) || ((scheme === "http" || scheme === "https") && bare);
  if (!isProxy) return null;
  if (!u.hostname || !u.port) return null;
  // Хост попадает в строку PAC, поэтому допускаем только безопасные символы.
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/i.test(u.hostname)) return null;
  const pacScheme = { socks5: "SOCKS5", socks: "SOCKS5", socks4: "SOCKS", http: "PROXY", https: "HTTPS" }[scheme];
  return {
    scheme: pacScheme, host: u.hostname, port: Number(u.port),
    user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password),
  };
}

chrome.webRequest.onAuthRequired.addListener(
  (details, cb) => {
    if (!details.isProxy) return cb({});
    chrome.storage.session.get("auth").then(({ auth }) => {
      // Пароль отдаётся только нашему прокси.
      const bare = (h) => String(h || "").replace(/^\[|\]$/g, "").toLowerCase();
      const ch = details.challenger || {};
      const mine = auth && auth.user && bare(ch.host) === bare(auth.host) && Number(ch.port) === Number(auth.port);
      cb(mine ? { authCredentials: { username: auth.user, password: auth.pass } } : {});
    });
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"]
);

let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; chrome.storage.local.set({ traffic }); }, 3000);
}

const HIST = 60;
let speed = { down: 0, up: 0, hist: [] };
let sec = { down: 0, up: 0 };
let realStats = false;
let lastHostStats = null;
let tickTimer = null;

function addBytes(down, up) {
  traffic.downTotal += down; traffic.downSess += down;
  traffic.upTotal += up; traffic.upSess += up;
  sec.down += down; sec.up += up;
  scheduleFlush();
}

function startTick() {
  stopTick();
  speed = { down: 0, up: 0, hist: [] };
  sec = { down: 0, up: 0 };
  tickTimer = setInterval(() => {
    const k = realStats ? 1 : 0.35;
    speed.down = speed.down * (1 - k) + sec.down * k;
    speed.up = speed.up * (1 - k) + sec.up * k;
    speed.hist.push([Math.round(speed.down), Math.round(speed.up)]);
    if (speed.hist.length > HIST) speed.hist.shift();
    sec = { down: 0, up: 0 };
  }, 1000);
}

function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  speed = { down: 0, up: 0, hist: [] };
}

function onHostStats(m) {
  realStats = true;
  if (lastHostStats) {
    const down = Math.max(0, m.down - lastHostStats.down);
    const up = Math.max(0, m.up - lastHostStats.up);
    addBytes(down, up);
  }
  lastHostStats = { down: m.down, up: m.up };
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (state.status !== "on" || realStats || d.fromCache) return;
    let host;
    try { host = new URL(d.url).hostname.toLowerCase(); } catch { return; }
    if (!shouldProxy(host)) return;
    const h = d.responseHeaders && d.responseHeaders.find((x) => x.name.toLowerCase() === "content-length");
    const down = h ? parseInt(h.value, 10) || 0 : 0;
    addBytes(down, 600 + d.url.length);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

async function updateList() {
  await boot;
  const urls = settings.listUrls.split(/\s+/).filter((u) => /^https:\/\//.test(u));
  const all = new Set();
  let ok = 0;
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) continue;
      const txt = await r.text();
      if (txt.length > MAX_LIST_BYTES) continue;
      parseDomains(txt).forEach((d) => all.add(d));
      ok++;
    } catch {}
  }
  if (!ok) { log("Списки блокировок: загрузка не удалась"); return { ok: false, error: "Не удалось скачать списки" }; }
  const list = [...all];
  listInfo = { count: list.length, updated: Date.now() };
  log(`Списки блокировок обновлены: ${list.length} доменов`);
  await chrome.storage.local.set({ blocked: list, listInfo });
  rebuildSets(list);
  await applyProxy();
  return { ok: true, listInfo };
}

function disconnectHost() {
  if (port) { const p = port; port = null; try { p.postMessage({ cmd: "stop" }); p.disconnect(); } catch {} }
}

// Если VPN уже работал и включён kill-switch, трафик блокируется до ручного отключения.
async function fail(message) {
  disconnectHost();
  clearTimeout(reconnectTimer);
  stopTick();
  await chrome.storage.session.remove("auth");
  if (settings.killSwitch && endpoint) {
    endpoint = DEAD;
    setState({ status: "error", message, server: "", health: null });
    await applyProxy();
  } else {
    endpoint = "";
    await clearProxy();
    setState({ status: "error", message, server: "", health: null });
  }
}

async function connect(auto = false) {
  await boot;
  clearTimeout(reconnectTimer);
  disconnectHost();
  if (!auto) reconnects = 0;
  await chrome.storage.session.remove("auth");
  traffic.downSess = traffic.upSess = 0;
  traffic.sessStart = Date.now();
  chrome.storage.local.set({ traffic });
  realStats = false;
  lastHostStats = null;
  startTick();
  if (settings.autoUpdate && Date.now() - listInfo.updated > DAY) updateList();

  const input = (settings.source || "").trim();
  if (!input) return fail("Укажите ссылку или ключ в настройках");
  const direct = parseDirect(input);
  if (direct) {
    if (direct.scheme === "SOCKS5" && direct.user) {
      return fail("SOCKS5 с логином/паролем не поддерживается браузером — используйте http(s) прокси");
    }
    if (direct.user) await chrome.storage.session.set({ auth: { user: direct.user, pass: direct.pass, host: direct.host, port: direct.port } });
    endpoint = `${direct.scheme} ${direct.host}:${direct.port}`;
    setState({ status: "on", message: "Подключено", server: `${direct.host}:${direct.port}`, health: null });
    return applyProxy();
  }

  setState({ status: "connecting", message: auto ? "Переподключение…" : "Запуск…", server: "", health: null });
  let p;
  try {
    p = chrome.runtime.connectNative(HOST);
  } catch (e) {
    return fail(String(e));
  }
  port = p;
  p.onMessage.addListener(async (m) => {
    if (port !== p) return;
    if (m.event === "stats") return onHostStats(m);
    if (m.event === "progress") return setState({ message: m.message });
    if (m.event === "servers") return saveServers(m.servers);
    if (m.event === "health") {
      log(m.ok ? `Проверка связи: ${m.ms} мс` : "Проверка связи не прошла: " + (m.message || ""));
      return setState({ health: { ok: !!m.ok, ms: m.ms || 0, message: m.message || "" } });
    }
    if (m.event === "started") {
      reconnects = 0;
      log(`Хост запустил ядро: ${m.protocol}, локальный порт ${m.port}`);
      endpoint = `PROXY 127.0.0.1:${m.port}`;
      await chrome.storage.session.set({ auth: { user: m.user, pass: m.pass, host: "127.0.0.1", port: m.port } });
      setState({ status: "on", message: "Подключено", server: m.server });
      return applyProxy();
    }
    if (m.event === "error") return fail(m.message);
  });
  p.onDisconnect.addListener(async () => {
    const err = chrome.runtime.lastError?.message || "";
    if (port !== p) return;
    port = null;
    if (state.status === "off") return;
    const missing = /not found|forbidden|not allowed/i.test(err);
    if (!missing && reconnects < RETRY_MS.length) {
      const d = RETRY_MS[reconnects++];
      log(`Хост завершился${err ? ": " + err : ""}, повтор ${reconnects} из ${RETRY_MS.length}`);
      stopTick();
      setState({ status: "connecting", message: `Переподключение через ${d / 1000} с…`, health: null });
      reconnectTimer = setTimeout(() => connect(true), d);
      return;
    }
    await fail(
      missing
        ? "Не найден хост. Запустите установщик VPN Terminal. Без него работают только socks5 и http прокси."
        : "Хост завершился неожиданно" + (err ? " [" + err + "]" : "")
    );
  });
  log("Запуск: " + (/^https?:/i.test(input) ? "подписка" : "ссылка " + input.split(":")[0]));
  p.postMessage({ cmd: "start", url: input, port: 0, server: settings.server });
}

async function disconnect() {
  log("Отключение");
  clearTimeout(reconnectTimer);
  reconnects = 0;
  setState({ status: "off", message: "", server: "", health: null });
  disconnectHost();
  stopTick();
  endpoint = "";
  persistState();
  await chrome.storage.session.remove("auth");
  await chrome.storage.local.set({ traffic });
  await clearProxy();
}

function saveServers(list) {
  servers = Array.isArray(list) ? list.map((s) => ({ name: String(s.name), type: String(s.type) })) : [];
  chrome.storage.local.set({ servers });
  log(`Серверов в подписке: ${servers.length}`);
}

async function listServers() {
  const input = (settings.source || "").trim();
  if (!input || parseDirect(input)) {
    saveServers([]);
    return { ok: true };
  }
  try {
    const r = await chrome.runtime.sendNativeMessage(HOST, { cmd: "servers", url: input });
    if (r && r.event === "servers") {
      saveServers(r.servers);
      return { ok: true };
    }
    return { ok: false, error: (r && r.message) || "Нет ответа от хоста" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const snapshot = () => ({ state, settings, traffic, speed, realStats, listInfo, listLocal: sets.blocked.size, servers });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type === "state") return false;
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    await boot;
    switch (msg.type) {
      case "getState": return snapshot();
      case "connect": await connect(); return snapshot();
      case "disconnect": await disconnect(); return snapshot();
      case "listServers": return await listServers();
      case "getLog": return logBuf;
      case "clearLog":
        logBuf = [];
        await chrome.storage.local.set({ log: logBuf });
        return [];
      case "saveSettings": {
        const patch = sanitize(msg.settings);
        const changed = Object.keys(patch).filter((k) => settings[k] !== patch[k]);
        if (changed.length) log("Настройки изменены: " + changed.join(", "));
        const sourceChanged = changed.includes("source");
        settings = { ...settings, ...patch };
        if (sourceChanged) { settings.server = ""; saveServers([]); clearTimeout(listTimer); listTimer = setTimeout(listServers, 1500); }
        await chrome.storage.local.set({ settings });
        rebuildSets();
        await applyProxy();
        return snapshot();
      }
      case "updateList": return await updateList();
      case "resetTraffic":
        traffic = { ...traffic, downTotal: 0, upTotal: 0, downSess: 0, upSess: 0 };
        await chrome.storage.local.set({ traffic });
        return snapshot();
    }
  })().then(reply);
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await boot;
  const { settings: s } = await chrome.storage.local.get("settings");
  if (!s) await chrome.storage.local.set({ settings });
  if (settings.autoConnect && state.status === "off") connect();
});

// Прокси прошлой сессии указывает на мёртвый порт. При автоподключении с kill-switch держим блокировку, пока VPN не поднимется.
chrome.runtime.onStartup.addListener(async () => {
  await boot;
  log("Запуск браузера");
  disconnectHost();
  reconnects = 0;
  if (settings.autoConnect) {
    if (settings.killSwitch && settings.mode === "all") {
      endpoint = DEAD;
      await applyProxyForce();
    } else {
      await clearProxy();
    }
    connect();
  } else {
    await clearProxy();
    endpoint = "";
    setState({ status: "off", message: "", server: "", health: null });
  }
});

async function applyProxyForce() {
  await chrome.proxy.settings.set({
    scope: "regular",
    value: { mode: "pac_script", pacScript: { data: buildPac(), mandatory: true } },
  });
}
