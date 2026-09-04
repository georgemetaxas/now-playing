# Tapo light sync 💡

Tints a TP-Link **Tapo LED strip (L900 / L920 / L930)** to match the cover art
of whatever you're playing on YouTube Music — driven by the same Last.fm feed as
the [Now Playing](../README.md) display.

This is a small Python script that runs in the background on a computer **on the
same Wi-Fi as the strip** (the standalone-screen Mac is ideal). The web app can't
talk to the strip directly — browsers can't reach local smart-home devices — so
this helper does the polling and lighting.

## How it works

Every few seconds it asks Last.fm what's playing, finds the cover art (hi-res via
iTunes, same as the display), extracts the most vivid colour, and sets the
strip's hue/saturation to match. When nothing's playing it dims to a warm idle
(configurable).

## Setup

```bash
cd lights
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp config.example.json config.json   # then edit config.json
```

Fill in `config.json`:

| Field | What |
|---|---|
| `tapo_email` / `tapo_password` | Your **TP-Link / Tapo account** login (needed even for local control on current firmware). |
| `locations` | One entry per network. Each has a `name` and either a single `strip_ip`/`model`/`mac`, or a `strips` list for **multiple strips at one location** (all get the same colour). The agent auto-picks the location whose strip(s) are on the current subnet, and does nothing when on neither. Optionally add per-location `tapo_email` / `tapo_password` if strips are on a different account. |
| `strip_ip` (per location) | The strip's local IP — **Tapo app → strip → Settings (gear) → Device Info → IP Address**, or your router's client list. Give it a DHCP reservation so it doesn't change. |
| `model` (per location) | `l900`, `l920`, or `l930`. |
| `mac` (per location, optional) | The strip's MAC address. If set, the agent recovers automatically when the router gives the strip a new IP — it re-scans, finds it by MAC, reconnects, and saves the new IP. Without a MAC it still recovers by finding any Tapo device on that subnet. So a DHCP reservation is nice-to-have, not required. |
| `lastfm_user` / `lastfm_key` | Already filled with the Now Playing defaults. |
| `brightness` | Playing brightness, 1–100. |
| `idle_mode` | `restore` (back to the colour set in Google Home — default), `dim` (warm low light), `off` (turn strip off), or `keep` (hold last colour). |

> 🔒 `config.json` holds your TP-Link password and is **git-ignored** — it is never
> committed. You can also pass the secrets via `TAPO_EMAIL` / `TAPO_PASSWORD`
> environment variables instead of putting them in the file.

## Run

```bash
.venv/bin/python tapo_sync.py
```

You'll see lines like `♪ Mindchatter — Here I Go Again  →  hue 320°, sat 88%`.
Press Ctrl-C to stop.

### Keep it running automatically (launchd)

Easiest: run the installer — it creates the venv, installs deps, and installs +
loads a login agent with the right paths for this Mac (re-runnable):

```bash
cd lights && bash install.sh
```

Or manually, after `config.json` is filled in:

```bash
# from the repo root
cp lights/com.metaxas.nowplaying-lights.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.metaxas.nowplaying-lights.plist
```

### Running on a second Mac (e.g. the Hive)

The agent can run on any Mac that's on the same Wi-Fi as the strip — it does
**not** need Claude, just Python 3.8+. To set it up on another machine:

```bash
git clone https://github.com/georgemetaxas/now-playing.git
cd now-playing/lights
cp config.example.json config.json     # then edit: tapo login + strip IP/model
bash install.sh
```

`install.sh` figures out the paths for that machine, so the launch agent works
regardless of username or folder. Each machine keeps its own local `config.json`
(secrets never leave the device). Make sure the Mac is set to **not sleep** (System
Settings → energy) so the agent keeps running when the screen is off.

Manage it:

```bash
launchctl list | grep nowplaying-lights        # is it running?
tail -f lights/tapo_sync.log                    # watch output
launchctl unload ~/Library/LaunchAgents/com.metaxas.nowplaying-lights.plist   # stop
```

After editing `config.json`, reload with `unload` then `load` to pick up changes.
The agent uses absolute paths to this folder — if you move the project, update the
paths in the `.plist` (and the copy in `~/Library/LaunchAgents/`).
