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
  progress: $("progress"), progressFill: $("progress-fill"), screensaver: $("screensaver"),
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
let trackStart = 0;                     // when current track first appeared (perf time)
let trackDurMs = 0;                     // iTunes-reported duration, 0 = unknown

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
    if (now) await showTrack(now);
    else showScreensaver();
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

  els.screensaver.classList.add("hidden");
  els.player.classList.remove("hidden");

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
  } else {
    els.art.removeAttribute("src");
    els.backdrop.style.backgroundImage = "";
  }

  // text
  els.title.textContent = title;
  let year = itunes.year;
  if (!year) year = await fetchYear(artist, title, album);
  els.subtitle.textContent = [artist, year].filter(Boolean).join(" · ");

  // estimated progress for this track
  trackDurMs = itunes.durationMs || 0;
  trackStart = performance.now();

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

// Estimated playback progress bar (Last.fm gives no real position)
function tickProgress() {
  const playing = !els.player.classList.contains("hidden") && mode === "art";
  if (playing && trackDurMs > 0) {
    const frac = Math.min(1, (performance.now() - trackStart) / trackDurMs);
    els.progressFill.style.width = (frac * 100) + "%";
    els.progress.style.opacity = "1";
  } else {
    els.progress.style.opacity = "0";
  }
  requestAnimationFrame(tickProgress);
}

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
function showScreensaver() {
  currentKey = null;
  els.video.src = "about:blank";
  els.player.classList.add("hidden");
  els.screensaver.classList.remove("hidden");
  buildMosaic();
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
tickClock();
setInterval(tickClock, 1000);
requestAnimationFrame(tickProgress);
poll();
setInterval(poll, POLL_MS);

if (!cfg.user || !cfg.key) openSettings();
