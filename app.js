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
  catch { stored = {}; }
  return { ...DEFAULTS, ...stored };
}
function saveConfig() { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

/* ============================================================
   DOM
   ============================================================ */
const $ = (id) => document.getElementById(id);
const els = {
  backdrop: $("backdrop"), player: $("player"), art: $("art"), video: $("video"),
  title: $("title"), titleWrap: $("title-wrap"), subtitle: $("subtitle"),
  layoutToggle: $("layout-toggle"), screensaver: $("screensaver"),
  mosaic: $("mosaic"), clock: $("clock"), date: $("date"),
  modeToggle: $("mode-toggle"), settings: $("settings"),
  cfgUser: $("cfg-user"), cfgKey: $("cfg-key"),
};

/* ============================================================
   State
   ============================================================ */
let mode = cfg.mode || "art";          // "art" | "video"
let currentKey = null;                  // identity of the track currently shown
let artCache = [];                      // recent cover art URLs for the mosaic
const yearCache = {};
let layout = cfg.layout || "fullbleed"; // "fullbleed" | "albumart"
let view = "screensaver";               // "player" | "screensaver"
let idleTimer = null;                   // grace timer before falling back to screensaver

const IDLE_DELAY_MS = 25000;            // keep last track up this long after it stops

/* ============================================================
   Last.fm polling
   ============================================================ */
const POLL_MS = 10000;

async function lastfm(method, params = {}) {
  if (!cfg.user || !cfg.key) return null;
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({
    method, api_key: cfg.key, format: "json", ...params,
  }).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error("Last.fm " + res.status);
  return res.json();
}

async function poll() {
  if (!cfg.user || !cfg.key) { showScreensaver(); return; }
  try {
    const data = await lastfm("user.getRecentTracks", { user: cfg.user, limit: 8 });
    const tracks = data?.recenttracks?.track || [];
    const list = Array.isArray(tracks) ? tracks : [tracks];

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
  applyMode();

  if (key === currentKey) return; // same track, nothing to refresh
  currentKey = key;

  // iTunes lookup gives both high-res art and a release year
  const itunes = await fetchItunes(artist, title, album);
  const lfArt = pickImage(t.image);
  const art = itunes.art || (isPlaceholderArt(lfArt) ? "" : lfArt) || "";
  if (art) {
    els.art.src = art;
    els.backdrop.style.backgroundImage = `url("${art}")`;
    applyAccent(art);
  } else {
    els.art.removeAttribute("src");
    els.backdrop.style.backgroundImage = "";
    setAccent(null);
  }

  // text
  els.title.textContent = title;
  let year = itunes.year;
  if (!year) year = await fetchYear(artist, title, album);
  els.subtitle.textContent = [artist, year].filter(Boolean).join(" · ");

  // re-trigger entrance animation + scroll long titles
  retrigger(els.title); retrigger(els.subtitle);
  applyTitleScroll();

  // load video for video mode
  loadVideo(title, artist);
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
function applyLayout() {
  const album = layout === "albumart";
  els.player.classList.toggle("albumart", album);
  els.layoutToggle.textContent = album ? "⛶ Art" : "⊡ Bleed";
  applyTitleScroll();
}
els.layoutToggle.addEventListener("click", () => {
  layout = layout === "fullbleed" ? "albumart" : "fullbleed";
  cfg.layout = layout; saveConfig();
  applyLayout();
});

/* ============================================================
   Art / Video mode
   ============================================================ */
function applyMode() {
  const video = mode === "video";
  els.video.style.display = video ? "block" : "none";
  els.art.style.display = video ? "none" : "block";
  els.modeToggle.textContent = video ? "▶ Video" : "◼ Art";
}

function loadVideo(title, artist) {
  if (mode !== "video") { els.video.src = "about:blank"; return; }
  const q = encodeURIComponent(`${artist} ${title}`);
  // listType=search plays the first YouTube result — no API key needed
  els.video.src =
    `https://www.youtube-nocookie.com/embed?listType=search&list=${q}` +
    `&autoplay=1&mute=0&modestbranding=1&rel=0`;
}

els.modeToggle.addEventListener("click", () => {
  mode = mode === "art" ? "video" : "art";
  cfg.mode = mode; saveConfig();
  applyMode();
  if (mode === "video" && currentKey) {
    const [artist, title] = currentKey.split(" — ");
    loadVideo(title, artist);
  } else {
    els.video.src = "about:blank";
  }
});

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
    } catch { setAccent(null); }            // tainted canvas → white
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
      const r = j?.results?.[0];
      if (r?.artworkUrl100) {
        return {
          art: r.artworkUrl100.replace("100x100bb", "1000x1000bb"),
          year: r.releaseDate ? r.releaseDate.slice(0, 4) : "",
          durationMs: r.trackTimeMillis || 0,
        };
      }
    } catch {}
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
    const wiki = info?.track?.wiki?.published; // e.g. "06 Sep 2011, 14:00"
    const m = wiki && wiki.match(/\b(19|20)\d{2}\b/);
    if (m) year = m[0];
  } catch {}
  if (!year) {
    try {
      const q = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
      const res = await fetch(
        `https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=1`);
      const j = await res.json();
      const date = j?.recordings?.[0]?.["first-release-date"];
      if (date) year = date.slice(0, 4);
    } catch {}
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
  els.screensaver.classList.remove("visible");
  els.player.classList.add("visible");
}

function toScreensaver() {
  view = "screensaver";
  currentKey = null;
  els.video.src = "about:blank";
  setAccent(null);
  buildMosaic();
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

function buildMosaic() {
  const arts = artCache.length ? artCache : [];
  if (!arts.length) { els.mosaic.innerHTML = ""; return; }
  // fill a grid of ~24 tiles, cycling through available art
  const tiles = 24;
  els.mosaic.innerHTML = "";
  for (let i = 0; i < tiles; i++) {
    const d = document.createElement("div");
    d.style.backgroundImage = `url("${arts[i % arts.length]}")`;
    d.style.animationDelay = (i * 0.04) + "s";
    els.mosaic.appendChild(d);
  }
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

$("fs-btn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

/* ============================================================
   Boot
   ============================================================ */
applyMode();
applyLayout();
toScreensaver();
tickClock();
setInterval(tickClock, 1000);
poll();
setInterval(poll, POLL_MS);

if (!cfg.user || !cfg.key) openSettings();
