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
    cfg["strip_ip"] = str(cfg.get("strip_ip", "")).strip()
    for key in ("tapo_email", "tapo_password", "strip_ip", "lastfm_user", "lastfm_key"):
        if not cfg.get(key):
            sys.exit(f"config.json is missing required field: {key}")
    cfg.setdefault("model", "l930")
    cfg.setdefault("poll_seconds", 8)
    cfg.setdefault("brightness", 80)
    cfg.setdefault("idle_mode", "restore")  # "restore" | "dim" | "off" | "keep"
    cfg.setdefault("idle_brightness", 15)
    return cfg


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
def fetch_art_url(artist, title, album, lastfm_image):
    clean_album = album.split(" (feat.")[0].strip() if album else ""
    terms = [f"{artist} {title}"]
    if clean_album:
        terms.append(f"{artist} {clean_album}")
    terms.append(title)
    for term in terms:
        try:
            q = urllib.parse.urlencode({"term": term, "entity": "song", "limit": 1})
            r = requests.get(f"https://itunes.apple.com/search?{q}", timeout=10)
            results = r.json().get("results", [])
            if results and results[0].get("artworkUrl100"):
                return results[0]["artworkUrl100"].replace("100x100bb", "600x600bb")
        except Exception:
            pass
    if lastfm_image and LASTFM_PLACEHOLDER not in lastfm_image:
        return lastfm_image
    return None


def dominant_color(art_url):
    """Download the art and return (hue 0-360, sat 0-100) of its most vivid pixel.
    Returns None for near-grayscale art (caller falls back to warm white)."""
    r = requests.get(art_url, timeout=10)
    r.raise_for_status()
    img = Image.open(io.BytesIO(r.content)).convert("RGB").resize((40, 40))
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
async def get_device(client, cfg):
    factory = getattr(client, cfg["model"].lower())   # l900 / l920 / l930
    return await factory(cfg["strip_ip"])


async def set_color(device, hue, sat, brightness):
    await device.set().on().brightness(brightness).hue_saturation(hue, sat).send(device)


async def set_warm_white(device, brightness):
    # low saturation amber for grayscale covers
    await device.set().on().brightness(brightness).hue_saturation(30, 25).send(device)


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
    client = ApiClient(cfg["tapo_email"], cfg["tapo_password"])
    device = await get_device(client, cfg)
    print(f"Connected to {cfg['model'].upper()} at {cfg['strip_ip']}. Watching {cfg['lastfm_user']}…")

    last_key = None        # last track we set a colour for
    playing = None         # None = unknown (startup/reconnect), True/False otherwise
    idle_applied = False   # have we applied the idle state since playback stopped
    home_state = await capture_state(device)   # initial Google Home colour

    while True:
        try:
            np = get_now_playing(cfg)
            if np:
                # On a real idle→playing transition, re-snapshot the current
                # colour so idle later restores the latest Google Home setting.
                if playing is False:
                    snap = await capture_state(device)
                    if snap:
                        home_state = snap
                if playing is not True:
                    playing = True
                    idle_applied = False
                    last_key = None

                artist, title, album, lf_img = np
                key = f"{artist} — {title}"
                if key != last_key:
                    last_key = key
                    art = fetch_art_url(artist, title, album, lf_img)
                    color = dominant_color(art) if art else None
                    if color:
                        hue, sat = color
                        await set_color(device, hue, sat, cfg["brightness"])
                        print(f"♪ {key}  →  hue {hue}°, sat {sat}%")
                    else:
                        await set_warm_white(device, cfg["brightness"])
                        print(f"♪ {key}  →  warm white (no vivid colour)")
            else:
                if not idle_applied:
                    await go_idle(device, cfg, home_state)
                    idle_applied = True
                    playing = False
                    last_key = None
                    print("· nothing playing → "
                          + ("restored Google Home colour" if cfg["idle_mode"] == "restore"
                             else "idle"))
        except Exception as e:
            # Tapo sessions expire (SessionTimeout/403) — a fresh handle isn't
            # enough, so log in again from scratch and re-apply on next loop.
            print(f"! {type(e).__name__}: {e}  → re-authenticating", file=sys.stderr)
            try:
                client = ApiClient(cfg["tapo_email"], cfg["tapo_password"])
                device = await get_device(client, cfg)
                last_key = None       # force the colour to be re-applied
                playing = None        # don't re-snapshot from our own colour
                idle_applied = False
                print("· reconnected to strip")
            except Exception as e2:
                print(f"! reconnect failed: {e2}", file=sys.stderr)

        await asyncio.sleep(cfg["poll_seconds"])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
