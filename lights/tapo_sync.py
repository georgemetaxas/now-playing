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
    cfg.setdefault("idle_mode", "dim")      # "dim" | "off" | "keep"
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


async def go_idle(device, cfg):
    if cfg["idle_mode"] == "off":
        await device.off()
    elif cfg["idle_mode"] == "dim":
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
    idle_set = False       # have we already applied the idle state

    while True:
        try:
            np = get_now_playing(cfg)
            if np:
                idle_set = False
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
                if not idle_set:
                    await go_idle(device, cfg)
                    idle_set = True
                    last_key = None
                    print("· nothing playing → idle")
        except Exception as e:
            print(f"! {type(e).__name__}: {e}", file=sys.stderr)
            # try to re-establish the device handle on persistent errors
            try:
                device = await get_device(client, cfg)
            except Exception:
                pass

        await asyncio.sleep(cfg["poll_seconds"])


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped.")
