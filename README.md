# Now Playing 🎵

A full-screen "now playing" display for whatever you're listening to on **YouTube Music**, designed to run on a standalone screen. Shows full-bleed cover art, the track / artist / year, a **music-video mode** toggle, and a clock **screensaver** when nothing's playing.

It's a pure static site — no backend — so it hosts free on GitHub Pages and works on any device.

## How it knows what you're playing

YouTube Music has no official now-playing API, so this app reads your **Last.fm** feed:

1. Create a free Last.fm account.
2. Install the free [**Web Scrobbler**](https://web-scrobbler.com/) browser extension on any browser where you play YouTube Music. It detects YT Music playback and reports it to Last.fm in real time.
3. Open this app, hit ⚙ **Settings**, and enter your Last.fm username + a free [API key](https://www.last.fm/api/account/create).

The app polls Last.fm every 10s and reflects your current track on any device showing the page.

## Features

- **Full-bleed cover art** (high-res via iTunes artwork lookup, falls back to Last.fm art)
- **Art ↔ Video** toggle — video mode embeds the matching YouTube result (no API key needed)
- **Year** resolved from Last.fm, falling back to MusicBrainz
- **Screensaver** — big clock + date over an animated mosaic of your recent cover art
- **Fullscreen** button for kiosk/standalone displays

## Run locally

Any static server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source: Deploy from branch → `main` / root**.
3. Your display lives at `https://<you>.github.io/<repo>/`.

Settings (username/API key/mode) are stored in each device's `localStorage`.
