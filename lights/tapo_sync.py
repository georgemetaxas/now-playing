#!/usr/bin/env python3
"""
Tapo light sync — tints a TP-Link Tapo LED strip (L900 / L920 / L930) to match
the cover art of whatever is currently playing on your YouTube Music account
(via the same Last.fm feed the Now Playing display uses).

Runs in a loop on a machine that's on the same Wi-Fi as the strip.
Configure it with config.json (copy config.example.json). See README.md.
"""

import asyncio
import colorsys
import io
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.parse

import requests
from PIL import Image
from tapo import ApiClient

HERE = os.path.dirname(os.path.abspath(__file__))
LASTFM_PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f"

# flush each log line immediately (so the launchd log file stays live)
try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass


# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
def load_config():
    path = os.path.join(HERE, "config.json")
    if not os.path.exists(path):
        sys.exit("Missing config.json — copy config.example.json and fill it in.")
    with open(path) as f:
        cfg = json.load(f)
    # env overrides (handy for secrets)
    cfg["tapo_email"] = os.environ.get("TAPO_EMAIL", cfg.get("tapo_email", "")).strip()
    cfg["tapo_password"] = os.environ.get("TAPO_PASSWORD", cfg.get("tapo_password", "")).strip()
    for key in ("tapo_email", "tapo_password", "lastfm_user", "lastfm_key"):
        if not cfg.get(key):
            sys.exit(f"config.json is missing required field: {key}")

    # Locations. New style: a "locations" list, one per network/strip. Legacy
    # style: a single top-level strip_ip/model → treated as one location.
    raw = cfg.get("locations")
    if not raw:
        legacy = str(cfg.get("strip_ip", "")).strip()
        if not legacy:
            sys.exit("config.json needs a 'locations' list (or a legacy 'strip_ip').")
        raw = [{"name": "default", "strip_ip": legacy, "model": cfg.get("model", "l930")}]
    locations = []
    for loc in raw:
        # A location can have one strip (legacy strip_ip/model/mac) or many
        # (a "strips" list). Normalise to a list of strip dicts.
        raw_strips = loc.get("strips")
        if not raw_strips:
            ip = str(loc.get("strip_ip", "")).strip()
            raw_strips = [{"ip": ip, "model": loc.get("model"),
                           "mac": loc.get("mac", "")}] if ip else []
        strips = []
        for s in raw_strips:
            sip = str(s.get("ip") or s.get("strip_ip") or "").strip()
            if not sip:
                continue
            strips.append({
                "ip": sip,
                "model": str(s.get("model") or loc.get("model") or
                             cfg.get("model", "l930")).lower(),
                "mac": normmac(s.get("mac", "")),   # optional — enables IP auto-recovery
            })
        if not strips:
            continue
        locations.append({
            "name": loc.get("name", strips[0]["ip"]),
            "strips": strips,
            # per-location creds are optional; default to the shared account
            "tapo_email": (loc.get("tapo_email") or cfg["tapo_email"]).strip(),
            "tapo_password": (loc.get("tapo_password") or cfg["tapo_password"]).strip(),
        })
    if not locations:
        sys.exit("config.json has no usable locations (each needs a strip ip).")
    cfg["locations"] = locations

    cfg.setdefault("poll_seconds", 8)
    cfg.setdefault("brightness", 80)
    cfg.setdefault("idle_mode", "restore")  # "restore" | "dim" | "off" | "keep"
    cfg.setdefault("idle_brightness", 15)
    return cfg


def local_subnet():
    """This machine's primary IPv4 /24 prefix, e.g. '192.168.0.' — used to tell
    which location's network we're on right now (SSID isn't reliable on macOS)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))          # no packets sent; just picks the iface
        ip = s.getsockname()[0]
        s.close()
        return ip.rsplit(".", 1)[0] + "."
    except Exception:
        return ""


def pick_location(cfg):
    """The location whose strip is on our current subnet, or None if we're on
    neither known network (in which case we leave all lights alone)."""
    prefix = local_subnet()
    if not prefix:
        return None
    for loc in cfg["locations"]:
        if any(s["ip"].startswith(prefix) for s in loc["strips"]):
            return loc
    return None


# ---------------------------------------------------------------------------
# IP auto-recovery: if the strip's IP changes (DHCP), find it again by MAC
# (or any Tapo device on the subnet) so a fixed IP is never required.
# ---------------------------------------------------------------------------
TPLINK_OUIS = {
    "7c:f1:7e", "50:c7:bf", "60:32:b1", "98:da:c4", "a4:2b:b0", "cc:32:e5",
    "b0:a7:b9", "1c:61:b4", "3c:52:a1", "5c:a6:e6", "d8:0d:17", "30:de:4b",
    "48:22:54", "54:af:97", "ac:15:a2", "e8:48:b8", "f0:a7:31", "00:31:92",
    "9c:53:22", "b4:b0:24", "68:ff:7b", "a8:42:a1", "c0:06:c3", "10:27:f5",
}


def normmac(m):
    """Lowercase, colon-separated, zero-padded MAC (macOS arp drops leading 0s)."""
    m = (m or "").lower().replace("-", ":")
    if not m:
        return ""
    return ":".join(p.zfill(2) for p in m.split(":"))


def _ping_sweep(prefix):
    procs = []
    for i in range(1, 255):
        procs.append(subprocess.Popen(
            ["ping", "-c", "1", "-t", "1", prefix + str(i)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
    for p in procs:
        try:
            p.wait(timeout=2)
        except Exception:
            p.kill()


def _arp_table():
    try:
        out = subprocess.run(["arp", "-a", "-n"], capture_output=True,
                             text=True, timeout=8).stdout
    except Exception:
        return {}
    table = {}
    for line in out.splitlines():
        m = re.search(r"\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-fA-F:]+)", line)
        if m:
            table[m.group(1)] = normmac(m.group(2))
    return table


def rediscover_ip(loc):
    """Scan the current subnet and return the strip's current IP — by its MAC
    if we know it, else the first TP-Link/Tapo device found. None if not found."""
    prefix = local_subnet()
    if not prefix:
        return None
    _ping_sweep(prefix)
    table = _arp_table()
    want = loc.get("mac", "")
    if want:
        for ip, mac in table.items():
            if ip.startswith(prefix) and mac == want:
                return ip
    for ip, mac in table.items():                       # fallback: any Tapo OUI
        if ip.startswith(prefix) and mac[:8] in TPLINK_OUIS:
            return ip
    return None


def persist_strip_ip(loc_name, mac, old_ip, new_ip):
    """Save a recovered strip IP back into config.json so restarts skip the scan."""
    path = os.path.join(HERE, "config.json")
    try:
        raw = json.load(open(path))
        for l in raw.get("locations", []):
            if l.get("name") != loc_name:
                continue
            if isinstance(l.get("strips"), list):
                for s in l["strips"]:
                    hit = (mac and normmac(s.get("mac", "")) == mac) or \
                          ((s.get("ip") or s.get("strip_ip")) == old_ip)
                    if hit:
                        if "ip" in s or "strip_ip" not in s:
                            s["ip"] = new_ip
                        else:
                            s["strip_ip"] = new_ip
            else:
                l["strip_ip"] = new_ip      # legacy single-strip location
        json.dump(raw, open(path, "w"), indent=2)
    except Exception as e:
        print(f"! could not save new IP: {e}", file=sys.stderr)


async def connect_strip(client, strip, loc_name):
    """Connect to a strip; if unreachable at its known IP, rediscover it on the
    subnet (by MAC, else any Tapo device), update + persist the IP. Returns the
    device, or None if it can't be reached."""
    try:
        return await get_device_for(client, strip)
    except Exception:
        old = strip["ip"]
        print(f"· {loc_name} strip not at {old} — scanning…")
        new_ip = rediscover_ip(strip)
        if not new_ip:
            return None
        if new_ip != old:
            print(f"· {loc_name} strip moved to {new_ip} — updating")
            strip["ip"] = new_ip
            persist_strip_ip(loc_name, strip["mac"], old, new_ip)
        try:
            return await get_device_for(client, strip)
        except Exception:
            return None


# ----------------------------------------------------------------------------
# Last.fm now-playing
# ----------------------------------------------------------------------------
def get_now_playing(cfg):
    """Return (artist, title, album, lastfm_image) or None if nothing is playing."""
    params = {
        "method": "user.getRecentTracks", "user": cfg["lastfm_user"],
        "api_key": cfg["lastfm_key"], "format": "json", "limit": 1,
    }
    r = requests.get("https://ws.audioscrobbler.com/2.0/", params=params, timeout=10)
    r.raise_for_status()
    tracks = r.json().get("recenttracks", {}).get("track", [])
    if isinstance(tracks, dict):
        tracks = [tracks]
    for t in tracks:
        if t.get("@attr", {}).get("nowplaying") == "true":
            img = ""
            for im in t.get("image", []):
                if im.get("#text"):
                    img = im["#text"]
            artist = t.get("artist", {}).get("#text", "")
            album = t.get("album", {}).get("#text", "")
            return artist, t.get("name", ""), album, img
    return None


# ----------------------------------------------------------------------------
# Cover art lookup (iTunes hi-res, Last.fm fallback) — mirrors the web app
# ----------------------------------------------------------------------------
def _norm(s):
    s = (s or "").lower()
    s = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", s)
    s = re.sub(r"\b(feat|ft|featuring|remaster(ed)?|radio edit|extended mix|"
               r"original mix|deluxe|single)\b.*$", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _artist_matches(want, got):
    a, b = _norm(want), _norm(got)
    if not a or not b:
        return False
    if a == b or a in b or b in a:
        return True
    t = a.split(" ")[0]
    return len(t) >= 3 and t in b.split(" ")


def _name_matches(want, got):
    a, b = _norm(want), _norm(got)
    return bool(a) and bool(b) and (a == b or a in b or b in a)


def _itunes_search(term, entity, want_artist, want_name, is_album):
    """First result whose artist (and name) actually match — avoids the
    wrong-cover mismatches from taking the blind top result."""
    try:
        q = urllib.parse.urlencode({"term": term, "entity": entity, "limit": 8})
        r = requests.get(f"https://itunes.apple.com/search?{q}", timeout=10)
        for res in r.json().get("results", []):
            if not res.get("artworkUrl100"):
                continue
            if not _artist_matches(want_artist, res.get("artistName", "")):
                continue
            name = res.get("collectionName" if is_album else "trackName", "")
            if want_name and not _name_matches(want_name, name):
                continue
            return res
    except Exception:
        pass
    return None


def fetch_art_url(artist, title, album, lastfm_image):
    """Resolve the best cover: exact album (validated) → validated song →
    Last.fm's own art (from YouTube metadata, so faithful)."""
    clean_album = re.sub(r"\s*[\(\[](feat|ft)\.?[^\)\]]*[\)\]]", "",
                         album or "", flags=re.I).strip()
    if clean_album:
        alb = _itunes_search(f"{artist} {clean_album}", "album", artist, clean_album, True)
        if alb:
            return alb["artworkUrl100"].replace("100x100bb", "600x600bb")
    song = _itunes_search(f"{artist} {title}", "song", artist, title, False)
    if song:
        return song["artworkUrl100"].replace("100x100bb", "600x600bb")
    if lastfm_image and LASTFM_PLACEHOLDER not in lastfm_image:
        return lastfm_image
    return None


def dominant_color(art_url):
    """Download the art and return (hue 0-360, sat 0-100) of its most vivid pixel.
    Returns None for near-grayscale art or a failed download (caller falls back
    to warm white)."""
    try:
        r = requests.get(art_url, timeout=10)
        r.raise_for_status()
        img = Image.open(io.BytesIO(r.content)).convert("RGB").resize((40, 40))
    except Exception:
        return None
    best, best_score = None, -1.0
    for (rr, gg, bb) in img.getdata():
        mx, mn = max(rr, gg, bb), min(rr, gg, bb)
        sat = 0 if mx == 0 else (mx - mn) / mx
        score = sat * mx                       # vivid AND bright
        if score > best_score:
            best_score, best = score, (rr, gg, bb)
    if not best:
        return None
    h, s, v = colorsys.rgb_to_hsv(best[0] / 255, best[1] / 255, best[2] / 255)
    if s < 0.12:                               # near-grayscale → no strong hue
        return None
    return round(h * 360), max(60, round(s * 100))


# ----------------------------------------------------------------------------
# Tapo strip control
# ----------------------------------------------------------------------------
async def get_device_for(client, strip):
    factory = getattr(client, strip["model"])         # l900 / l920 / l930
    return await factory(strip["ip"])


async def _retry(coro_fn):
    """Run an async action, retrying once after a short pause — the strip can
    briefly reject a command mid-transition."""
    try:
        await coro_fn()
    except Exception:
        await asyncio.sleep(0.6)
        await coro_fn()


async def set_color(device, hue, sat, brightness):
    await _retry(lambda: device.set().on().brightness(brightness)
                 .hue_saturation(hue, sat).send(device))


async def set_warm_white(device, brightness):
    # low saturation amber for grayscale covers
    await _retry(lambda: device.set().on().brightness(brightness)
                 .hue_saturation(30, 25).send(device))


async def capture_state(device):
    """Snapshot the strip's current colour — i.e. whatever Google Home set."""
    try:
        info = await device.get_device_info()
        return {
            "on": getattr(info, "device_on", True),
            "brightness": getattr(info, "brightness", None),
            "hue": getattr(info, "hue", None),
            "saturation": getattr(info, "saturation", None),
            "color_temp": getattr(info, "color_temp", None),
        }
    except Exception as e:
        print(f"! could not read strip state: {e}", file=sys.stderr)
        return None


async def restore_state(device, state):
    """Put the strip back to a captured snapshot (the Google Home colour)."""
    if not state:
        return
    if not state.get("on"):
        await device.off()
        return
    builder = device.set().on().brightness(state.get("brightness") or 100)
    ct = state.get("color_temp")
    hue, sat = state.get("hue"), state.get("saturation")
    if ct and ct > 0:
        builder = builder.color_temperature(ct)   # white setting
    elif hue is not None and sat is not None:
        builder = builder.hue_saturation(hue, sat)  # colour setting
    await builder.send(device)


async def go_idle(device, cfg, home_state):
    mode = cfg["idle_mode"]
    if mode == "restore":
        await restore_state(device, home_state)   # back to Google Home colour
    elif mode == "off":
        await device.off()
    elif mode == "dim":
        await device.set().on().brightness(cfg["idle_brightness"]).hue_saturation(30, 20).send(device)
    # "keep" → leave the last colour as-is


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------
async def main():
    cfg = load_config()
    where = ", ".join(
        f"{l['name']} (" + ", ".join(s['ip'] for s in l['strips']) + ")"
        for l in cfg["locations"])
    print(f"Watching {cfg['lastfm_user']}. Locations: {where}")

    client = None
    active_loc = None      # the location dict we're currently at
    units = []             # per-strip runtime: [{cfg, device, home}, ...]
    last_key = None        # last track we set a colour for
    active = False         # are we currently overriding the strips for playback?

    while True:
        try:
            desired = pick_location(cfg)
            if desired is None:
                # On neither known network → release everything and touch nothing.
                if active_loc is not None:
                    print("· off all known light networks — pausing control")
                active_loc = None
                units = []
                active = False
                last_key = None
                await asyncio.sleep(cfg["poll_seconds"])
                continue

            # Arrived at a location → build the per-strip runtime list.
            if active_loc is None or active_loc["name"] != desired["name"]:
                client = ApiClient(desired["tapo_email"], desired["tapo_password"])
                units = [{"cfg": s, "device": None, "home": None} for s in desired["strips"]]
                active_loc = desired
                active = False
                last_key = None

            # Ensure each strip is connected (rediscovers a moved IP on failure).
            for u in units:
                if u["device"] is None:
                    u["device"] = await connect_strip(client, u["cfg"], desired["name"])
                    if u["device"] is not None:
                        print(f"· at {desired['name']} → connected to "
                              f"{u['cfg']['model'].upper()} at {u['cfg']['ip']}")
            live = [u for u in units if u["device"] is not None]
            if not live:
                await asyncio.sleep(cfg["poll_seconds"])
                continue

            np = get_now_playing(cfg)
            if np:
                if not active:
                    # idle → playing: snapshot each strip's current state.
                    for u in live:
                        u["home"] = await capture_state(u["device"])
                    active = True
                    last_key = None

                artist, title, album, lf_img = np
                key = f"{artist} — {title}"
                if key != last_key:
                    last_key = key
                    art = fetch_art_url(artist, title, album, lf_img)
                    color = dominant_color(art) if art else None
                    for u in live:
                        try:
                            if color:
                                await set_color(u["device"], color[0], color[1], cfg["brightness"])
                            else:
                                await set_warm_white(u["device"], cfg["brightness"])
                        except Exception:
                            u["device"] = None      # drop; reconnect next loop
                    if color:
                        print(f"♪ {key}  →  hue {color[0]}°, sat {color[1]}%  ({len(live)} strip(s))")
                    else:
                        print(f"♪ {key}  →  warm white  ({len(live)} strip(s))")
            elif active:
                # playing → idle: restore each strip's pre-playback state ONCE.
                for u in live:
                    try:
                        await go_idle(u["device"], cfg, u["home"])
                    except Exception:
                        u["device"] = None
                active = False
                last_key = None
                print("· stopped → restored the strips to their previous state")
            # Steady idle (not active): never touch the strips.
        except Exception as e:
            # Tapo sessions expire, or a strip may be briefly unreachable — drop
            # the devices so the next loop reconnects (never disturbs `active`
            # while idle, so lights turned off in Google Home stay off).
            print(f"! {type(e).__name__}: {e}  → will reconnect", file=sys.stderr)
            for u in units:
                u["device"] = None

        await asyncio.sleep(cfg["poll_seconds"])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
