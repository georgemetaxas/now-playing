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
| `strip_ip` | The strip's local IP — find it in the **Tapo app → your strip → Settings (gear) → Device Info → IP Address**, or in your router's client list. Give the strip a DHCP reservation so it doesn't change. |
| `model` | `l900`, `l920`, or `l930`. |
| `lastfm_user` / `lastfm_key` | Already filled with the Now Playing defaults. |
| `brightness` | Playing brightness, 1–100. |
| `idle_mode` | `dim` (warm low light), `off` (turn strip off), or `keep` (hold last colour). |

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

A launch agent is included so the sync starts on login and restarts if it
crashes. After `config.json` is filled in:

```bash
# from the repo root
cp lights/com.metaxas.nowplaying-lights.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.metaxas.nowplaying-lights.plist
```

Manage it:

```bash
launchctl list | grep nowplaying-lights        # is it running?
tail -f lights/tapo_sync.log                    # watch output
launchctl unload ~/Library/LaunchAgents/com.metaxas.nowplaying-lights.plist   # stop
```

After editing `config.json`, reload with `unload` then `load` to pick up changes.
The agent uses absolute paths to this folder — if you move the project, update the
paths in the `.plist` (and the copy in `~/Library/LaunchAgents/`).
