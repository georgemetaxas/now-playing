"use strict";

/* ============================================================
   Config (stored in localStorage)
   ============================================================ */
const CFG_KEY = "ynp-config";

// Built-in defaults (Last.fm read API key is safe to expose client-side).
const DEFAULTS = {
  user: "gogom222",
  key: "7e6ab4d4806c231978b21444a58f5f7e",
};

const cfg = loadConfig();

function loadConfig() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; }
  catch (e) { stored = {}; }
  return { ...DEFAULTS, ...stored };
}
function saveConfig() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

/* ============================================================
   DOM
   ============================================================ */
const $ = (id) => document.getElementById(id);
const els = {
  backdrop: $("backdrop"), player: $("player"), art: $("art"), eq: $("eq"),
  title: $("title"), titleWrap: $("title-wrap"), subtitle: $("subtitle"),
  layoutToggle: $("layout-toggle"), screensaver: $("screensaver"),
  mosaic: $("mosaic"), clock: $("clock"), date: $("date"),
  settings: $("settings"),
  cfgUser: $("cfg-user"), cfgKey: $("cfg-key"),
};

/* ============================================================
   State
   ============================================================ */
let currentKey = null;                  // identity of the track currently shown
let artCache = [];                      // recent cover art URLs for the mosaic
let libraryArt = [];                    // top-album covers for the screensaver wall
const yearCache = {};
let layout = cfg.layout || "fullbleed"; // "fullbleed" | "albumart"
let view = "screensaver";               // "player" | "screensaver"
let idleTimer = null;                   // grace timer before falling back to screensaver

const IDLE_DELAY_MS = 25000;            // keep last track up this long after it stops

/* ============================================================
   Last.fm polling
   ============================================================ */
const POLL_MS = 7000;
const STALL_RELOAD_MS = 150000;    // if no successful poll for 2.5 min, reload
// Smaller artwork on phones/tablets — decodes far faster on older GPUs
const ART_SIZE = (("ontouchstart" in window) || window.innerWidth < 900)
  ? "600x600bb" : "1000x1000bb";
let lastPollOk = Date.now();        // timestamp of the last successful poll

async function lastfm(method, params = {}) {
  if (!cfg.user || !cfg.key) return null;
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method, api_key: cfg.key, format: "json", ...params,
    _: Date.now(),   // cache-bust: iOS Safari ignores cache:no-store on GETs
  }).toString();
  // abort hung requests so polls can't pile up on a long-running kiosk tab
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error("Last.fm " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function poll() {
  if (!cfg.user || !cfg.key) { toScreensaver(); return; }
  try {
    const data = await lastfm("user.getRecentTracks", { user: cfg.user, limit: 8 });
    const tracks = (data && data.recenttracks && data.recenttracks.track) || [];
    const list = Array.isArray(tracks) ? tracks : [tracks];
    lastPollOk = Date.now();

    // collect cover art for the mosaic
    artCache = list.map(t => pickImage(t.image)).filter(Boolean);

    const now = list.find(t => t["@attr"] && t["@attr"].nowplaying === "true");
    if (now) { clearIdle(); await showTrack(now); }
    else scheduleIdle();
  } catch (e) {
    console.error(e);
  }
}

function pickImage(images, size = "extralarge") {
  if (!Array.isArray(images)) return "";
  const order = ["mega", "extralarge", "large", "medium", "small"];
  const start = order.indexOf(size);
  for (let i = Math.max(0, start); i < order.length; i++) {
    const m = images.find(im => im.size === order[i]);
    if (m && m["#text"]) return m["#text"];
  }
  return "";
}

/* ============================================================
   Show a track
   ============================================================ */
async function showTrack(t) {
  const title = t.name;
  const artist = (t.artist && (t.artist["#text"] || t.artist.name)) || "";
  const album = (t.album && t.album["#text"]) || "";
  const key = artist + " — " + title;

  toPlayer();

  if (key === currentKey) return; // same track, nothing to refresh
  currentKey = key;

  // 1) Update text (and any Last.fm art) IMMEDIATELY so the change feels
  //    instant even on slow hardware. Hi-res art + year are filled in after.
  els.title.textContent = title;
  els.subtitle.textContent = artist;
  retrigger(els.title); retrigger(els.subtitle);
  applyTitleScroll();

  const lfArt = pickImage(t.image);
  if (lfArt && !isPlaceholderArt(lfArt)) {
    els.art.src = lfArt;
    els.backdrop.style.backgroundImage = `url("${lfArt}")`;
    applyAccent(lfArt);
  }

  // 2) Fetch hi-res art + release year in the background. Bail out if the
  //    track has changed again while we were waiting (avoids stale updates).
  const itunes = await fetchItunes(artist, title, album);
  if (currentKey !== key) return;

  const art = itunes.art || (isPlaceholderArt(lfArt) ? "" : lfArt) || "";
  if (art) {
    els.art.src = art;
    els.backdrop.style.backgroundImage = `url("${art}")`;
    applyAccent(art);
  } else if (isPlaceholderArt(lfArt)) {
    els.art.removeAttribute("src");
    els.backdrop.style.backgroundImage = "";
    setAccent(null);
  }

  let year = itunes.year;
  if (!year) year = await fetchYear(artist, title, album);
  if (currentKey !== key) return;
  els.subtitle.textContent = [artist, year].filter(Boolean).join(" · ");
}

function retrigger(node) {
  node.style.animation = "none";
  void node.offsetWidth;
  node.style.animation = "";
}

// Marquee long titles that overflow their container
function applyTitleScroll() {
  els.title.classList.remove("scroll");
  els.title.style.removeProperty("--scroll-dist");
  requestAnimationFrame(() => {
    const overflow = els.title.scrollWidth - els.titleWrap.clientWidth;
    if (overflow > 4) {
      els.title.style.setProperty("--scroll-dist", overflow + 24 + "px");
      els.title.classList.add("scroll");
    }
  });
}

// Full-bleed vs album-art layout
const layoutButtons = els.layoutToggle.querySelectorAll("button");
function applyLayout() {
  els.player.classList.toggle("albumart", layout === "albumart");
  layoutButtons.forEach(b => b.classList.toggle("active", b.dataset.layout === layout));
  applyTitleScroll();
}
layoutButtons.forEach(b => b.addEventListener("click", () => {
  layout = b.dataset.layout;
  cfg.layout = layout; saveConfig();
  applyLayout();
}));


/* ============================================================
   High-res artwork + year via iTunes Search (free, no key)
   Tries title first, then album — "feat." strings often fail.
   ============================================================ */
const LASTFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";
function isPlaceholderArt(url) {
  return !url || url.includes(LASTFM_PLACEHOLDER);
}

/* ============================================================
   Accent color extracted from cover art (tints title + bar)
   Reads pixels via a CORS-enabled image proxy (weserv), then
   picks the most vivid colour and lightens it for legibility.
   Falls back to white if extraction fails.
   ============================================================ */
function setAccent(hex) {
  document.documentElement.style.setProperty("--accent", hex || "#fff");
}

function applyAccent(artUrl) {
  const proxied = "https://images.weserv.nl/?w=40&h=40&url=" +
    encodeURIComponent(artUrl.replace(/^https?:\/\//, ""));
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const s = 40, cv = document.createElement("canvas");
      cv.width = s; cv.height = s;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, s, s);
      const d = ctx.getImageData(0, 0, s, s).data;
      let best = null, bestScore = -1;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        const score = sat * mx;            // vivid AND bright
        if (score > bestScore) { bestScore = score; best = [r, g, b]; }
      }
      setAccent(best ? vividHex(best) : null);
    } catch (e) { setAccent(null); }            // tainted canvas → white
  };
  img.onerror = () => setAccent(null);
  img.src = proxied;
}

function vividHex([r, g, b]) {
  let [h, s, l] = rgbToHsl(r, g, b);
  if (s < 0.12) return "#fff";              // near-grayscale art → keep white
  s = Math.min(0.95, Math.max(0.6, s));
  l = 0.72;                                 // bright enough for text on dark
  return rgbToHex(hslToRgb(h, s, l));
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0, l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const hue = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)]
    .map(x => Math.round(x * 255));
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function fetchItunes(artist, title, album) {
  const cleanAlbum = (album || "").replace(/\s*\(feat\.[^)]*\)/i, "").trim();
  const terms = [
    `${artist} ${title}`,
    cleanAlbum && `${artist} ${cleanAlbum}`,
    title,
  ].filter(Boolean);

  for (const term of terms) {
    try {
      const url = new URL("https://itunes.apple.com/search");
      url.search = new URLSearchParams({
        term, entity: "song", limit: "1",
      }).toString();
      const res = await fetch(url);
      const j = await res.json();
      const r = j && j.results && j.results[0];
      if (r && r.artworkUrl100) {
        return {
          art: r.artworkUrl100.replace("100x100bb", ART_SIZE),
          year: r.releaseDate ? r.releaseDate.slice(0, 4) : "",
          durationMs: r.trackTimeMillis || 0,
        };
      }
    } catch (e) {}
  }
  return { art: null, year: "", durationMs: 0 };
}

/* ============================================================
   Year lookup: Last.fm track.getInfo -> MusicBrainz fallback
   ============================================================ */
async function fetchYear(artist, title, album) {
  const ck = artist + "|" + title;
  if (yearCache[ck]) return yearCache[ck];
  let year = "";
  try {
    const info = await lastfm("track.getInfo", { artist, track: title });
    const wiki = info && info.track && info.track.wiki && info.track.wiki.published; // e.g. "06 Sep 2011, 14:00"
    const m = wiki && wiki.match(/\b(19|20)\d{2}\b/);
    if (m) year = m[0];
  } catch (e) {}
  if (!year) {
    try {
      const q = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
      const res = await fetch(
        `https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=1`);
      const j = await res.json();
      const date = j && j.recordings && j.recordings[0] && j.recordings[0]["first-release-date"];
      if (date) year = date.slice(0, 4);
    } catch (e) {}
  }
  yearCache[ck] = year;
  return year;
}

/* ============================================================
   Screensaver
   ============================================================ */
/* ---- View transitions (crossfade) + idle grace timer ---- */
function toPlayer() {
  view = "player";
  stopFlips();
  els.screensaver.classList.remove("visible");
  els.player.classList.add("visible");
}

function toScreensaver() {
  view = "screensaver";
  currentKey = null;
  setAccent(null);
  buildMosaic();
  startFlips();
  els.player.classList.remove("visible");
  els.screensaver.classList.add("visible");
}

function scheduleIdle() {
  if (view === "screensaver" || idleTimer) return; // already idle or counting down
  idleTimer = setTimeout(() => { idleTimer = null; toScreensaver(); }, IDLE_DELAY_MS);
}
function clearIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

/* ============================================================
   Equalizer bars — a simulated level meter (we have no audio
   signal, the music plays elsewhere). Staggered CSS animations
   keep it smooth on old hardware; colour comes from --accent.
   ============================================================ */
function buildEq() {
  const vw = window.innerWidth || 1280;
  const count = Math.max(16, Math.min(56, Math.round(vw / 26)));
  els.eq.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const b = document.createElement("div");
    b.className = "bar";
    b.style.height = (42 + Math.random() * 58).toFixed(1) + "%";   // varied peaks
    const dur = (0.5 + Math.random() * 0.95).toFixed(2) + "s";
    const delay = "-" + (Math.random() * 1.4).toFixed(2) + "s";     // desync instantly
    b.style.animationDuration = dur;
    b.style.animationDelay = delay;
    b.style.webkitAnimationDuration = dur;
    b.style.webkitAnimationDelay = delay;
    els.eq.appendChild(b);
  }
}

// Pool of cover art for the wall: your top albums, plus recent tracks.
function artPool() {
  return libraryArt.length ? libraryArt : artCache;
}
function pickArt() {
  const pool = artPool();
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : "";
}

function buildMosaic() {
  const pool = artPool();
  els.mosaic.innerHTML = "";
  if (!pool.length) return;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 720;
  const cols = Math.max(4, Math.round(vw / 175));
  const tileSize = Math.ceil(vw / cols);
  const rows = Math.ceil(vh / tileSize) + 1;
  // Explicit column count + row height — don't rely on grid 1fr sizing (iOS 12)
  els.mosaic.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
  els.mosaic.style.gridAutoRows = tileSize + "px";
  const count = Math.min(cols * rows, 200);
  for (let i = 0; i < count; i++) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.style.backgroundImage = `url("${pickArt()}")`;
    els.mosaic.appendChild(tile);
  }
}

// Flip a random tile to a new cover at random intervals (only while idle)
let flipTimer = null;
function startFlips() {
  stopFlips();
  const tick = () => {
    flipRandomTile();
    flipTimer = setTimeout(tick, 600 + Math.random() * 2200);
  };
  flipTimer = setTimeout(tick, 900);
}
function stopFlips() {
  if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
}
function flipRandomTile() {
  if (view !== "screensaver") return;
  const tiles = els.mosaic.children;
  if (!tiles.length || !artPool().length) return;
  const tile = tiles[Math.floor(Math.random() * tiles.length)];
  if (tile.classList.contains("flipping")) return;   // already mid-swap
  const art = pickArt();
  tile.classList.add("flipping");                    // squish to an edge
  setTimeout(() => {
    tile.style.backgroundImage = `url("${art}")`;    // swap cover while thin
    tile.classList.remove("flipping");               // expand back
  }, 370);
}

// Your library: top albums (reliable art) folded in with recent tracks
async function fetchLibrary() {
  try {
    const data = await lastfm("user.getTopAlbums", {
      user: cfg.user, period: "3month", limit: 60,
    });
    const albums = (data && data.topalbums && data.topalbums.album) || [];
    const arts = albums.map(a => pickImage(a.image))
      .filter(u => u && !isPlaceholderArt(u));
    if (arts.length) {
      libraryArt = arts;
      if (view === "screensaver") { buildMosaic(); startFlips(); }
    }
  } catch (e) { /* keep whatever pool we have */ }
}

function tickClock() {
  const now = new Date();
  let h = now.getHours(), m = now.getMinutes();
  const hh = ((h % 12) || 12);
  els.clock.textContent = `${hh}:${String(m).padStart(2, "0")}`;
  els.date.textContent = now.toLocaleDateString(undefined,
    { weekday: "long", day: "numeric", month: "long" });
}

/* ============================================================
   Settings + fullscreen
   ============================================================ */
$("settings-btn").addEventListener("click", openSettings);
$("cfg-close").addEventListener("click", () => els.settings.classList.add("hidden"));
$("cfg-save").addEventListener("click", () => {
  cfg.user = els.cfgUser.value.trim();
  cfg.key = els.cfgKey.value.trim();
  saveConfig();
  els.settings.classList.add("hidden");
  poll();
});
function openSettings() {
  els.cfgUser.value = cfg.user || "";
  els.cfgKey.value = cfg.key || "";
  els.settings.classList.remove("hidden");
}

const fsBtn = $("fs-btn");
const docEl = document.documentElement;
const canFullscreen = !!(docEl.requestFullscreen || docEl.webkitRequestFullscreen);
if (!canFullscreen) {
  // iOS Safari has no element Fullscreen API — use "Add to Home Screen" instead
  fsBtn.style.display = "none";
} else {
  fsBtn.addEventListener("click", () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      if (fsEl) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else {
        (docEl.requestFullscreen || docEl.webkitRequestFullscreen).call(docEl);
      }
    } catch (e) {}
  });
}

/* ============================================================
   Boot
   ============================================================ */
applyLayout();
buildEq();
toScreensaver();
tickClock();
setInterval(tickClock, 1000);
poll();
setInterval(poll, POLL_MS);

// Library art for the screensaver wall (refresh every 30 min)
fetchLibrary();
setInterval(fetchLibrary, 30 * 60 * 1000);

// Rebuild the wall on resize/orientation change while idle
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    buildEq();
    if (view === "screensaver") { buildMosaic(); startFlips(); }
  }, 300);
});

// Kiosk resilience: poll immediately when the tab wakes, and if polling has
// stalled for too long (network drop, browser throttling), reload the page.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});
setInterval(() => {
  if (cfg.user && cfg.key && Date.now() - lastPollOk > STALL_RELOAD_MS) {
    location.reload();
  }
}, 30000);

// Live dot: faint pulse while polling is healthy, solid red if it has stalled.
// (Healthy dot + frozen art means the scrobbler went quiet — reload YT Music.)
const liveDot = $("live-dot");
function updateLiveDot() {
  const configured = !!(cfg.user && cfg.key);
  const healthy = configured && (Date.now() - lastPollOk < 25000);
  liveDot.classList.toggle("live", healthy);
  liveDot.classList.toggle("stale", configured && !healthy);
}
updateLiveDot();
setInterval(updateLiveDot, 5000);

if (!cfg.user || !cfg.key) openSettings();
