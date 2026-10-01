MySoundTube - Docker Setup
==========================

A self-hosted web app to download SoundCloud and YouTube tracks and playlists as
MP3/M4A/FLAC/WAV with embedded metadata, and YouTube videos as MP4.
Protected by a password login.


QUICK START (local / docker compose)
-------------------------------------

1. Copy this folder to your machine.

2. Create a `.env` file from the example:

   ```bash
   cp .env.example .env
   ```

3. Generate a bcrypt hash for your password:

   ```bash
   python -c "import bcrypt; print(bcrypt.hashpw(b'yourpassword', bcrypt.gensalt()).decode())"
   ```

4. Edit `.env` and set your values:

   ```
   APP_PASSWORD=$$2b$$12$$<your_hash>   # escape every $ as $$
   PORT=5000
   ```

5. Build and start:

   ```bash
   docker compose up -d --build
   ```

6. Open http://localhost:5000 and log in with your `APP_PASSWORD`.


PORTAINER DEPLOYMENT
--------------------

1. Go to Stacks → Add stack.

2. Choose "Git repository" and point it to this repo.

3. Under "Environment variables" add:

   | Variable       | Value                                          | Required |
   |----------------|------------------------------------------------|----------|
   | `APP_PASSWORD` | bcrypt hash ($ signs do NOT need escaping here) | required |
   | `PORT`         | `5000` (or any free port on the host)           | optional |

4. Click Deploy. Portainer injects the values at deploy time.
   The `.env` file is gitignored and never committed.


ENVIRONMENT VARIABLES
---------------------

| Variable      | Description                                                      | Default    |
|---------------|------------------------------------------------------------------|------------|
| `APP_PASSWORD`| Bcrypt hash of the login password. Generate with:               | (required) |
|               | `python -c "import bcrypt; print(bcrypt.hashpw(b'pw', bcrypt.gensalt()).decode())"` | |
|               | In `.env` / `docker-compose`: escape every `$` as `$$`          |            |
| `SECRET_KEY`  | Signs session cookies. Auto-generated if omitted — sessions reset on container restart. | (optional) |
| `PORT`        | Host port exposed by the container.                              | `5000`     |
| `YTDLP_PROXY` | Proxy for all yt-dlp traffic (`http://user:pass@host:8080`, `socks5://host:1080`). Use one located in a country where the content is available to get around geo-restrictions. | (optional) |
| `YTDLP_COOKIES` | Path inside the container to a Netscape `cookies.txt` from a logged-in YouTube account. Needed for private playlists and "Sign in to confirm" errors. See below. | (optional) |


FEATURES
--------

Single track
  - Paste any SoundCloud or YouTube track URL
  - Auto-detects the platform and shows a badge (SoundCloud / YouTube)
  - Preview: fetches title, artist, duration, and cover art
  - Download as `MP3`, `M4A`, `FLAC`, or `WAV`
  - YouTube only: download as `MP4` video (best video + audio, merged)
    The MP4 format button appears automatically when a YouTube URL is detected

Playlist
  - Paste a SoundCloud `/sets/` URL or a YouTube playlist URL
  - A banner shows the playlist name and track count
  - "Convert All (ZIP)" downloads every track/video in one archive
  - `MP4` is available for YouTube playlists (one MP4 per video, zipped)

Download queue
  - Up to 5 downloads run concurrently
  - Additional jobs wait in a visual queue showing their position
  - Queue drains automatically as slots free up

Metadata embedded in every file
  - Title:  track/video title from the source platform
  - Artist: uploader name from the source platform
  - Album:  download date (`YYYYMMDD`)
  - Cover:  thumbnail embedded (audio formats and MP4). YouTube audio gets the
            square album cover (as shown on YouTube Music) instead of the 16:9 frame
            WAV: tags are written twice, as RIFF INFO and as an ID3v2.3 chunk holding
            the same fields plus the cover. Rekordbox reads the ID3 chunk when present,
            so it shows the cover. Already imported tracks: right-click, Reload Tag

Filename format:  `Artist - Track Title.ext`
Playlist files:   `01 - Artist - Track Title.ext`


HOW IT WORKS
------------
- Frontend: HTML/CSS/JS single-page app
- Backend:  Flask (Python)
- Auth:     session cookie, bcrypt-hashed password via `APP_PASSWORD` env var
- Download: `yt-dlp` (SoundCloud and YouTube support)
- Audio:    `ffmpeg` (conversion + metadata + thumbnail)
- Video:    `ffmpeg` (mux best video + audio streams into MP4)


PORTS
-----
Host port is controlled by the `PORT` env var (default `5000`).
To change it without editing `docker-compose.yml`, set `PORT=8080` in `.env`
or in Portainer's environment variables panel.


STOP
----
```bash
docker compose down
```


TROUBLESHOOTING
---------------

- **FLAC/WAV slow** — Normal, lossless conversion takes longer
- **MP4 slow** — Normal, `yt-dlp` fetches separate video and audio streams then merges them
- **Port conflict** — Set `PORT=8080` (or any free port) in `.env` or Portainer
- **`$` sign in hash broken** — In `.env`, escape every `$` in the bcrypt hash as `$$`
- **Error message** — The real yt-dlp error is shown in the UI, with a hint when it is a
  geo-restriction or a login problem
- **YouTube downloads failing / "formats missing"** — yt-dlp breaks whenever YouTube changes.
  Rebuild without cache to pull the latest yt-dlp: `docker compose build --no-cache && docker compose up -d`
- **Geo-restricted** — Set `YTDLP_PROXY` to a proxy in a country where the track is available.
  Alternative: run the stack behind a VPN container such as gluetun
  (`network_mode: "service:gluetun"`)
- **SoundCloud Go+ tracks** — Only a 30 s preview is public; no tool can fetch the full track
  without a Go+ subscription


PRIVATE PLAYLISTS
-----------------

SoundCloud: private sets work with their secret share link, the one ending in `/s-XXXXXXXX`
(Share -> copy the private link). The plain `/sets/name` URL fails for a private set.

YouTube: private playlists (and Liked / Watch later) need a logged-in session.

1. In a private browser window, log in to YouTube, then export cookies for youtube.com
   in Netscape format (e.g. the "Get cookies.txt LOCALLY" extension) and close the window
   without logging out (YouTube rotates cookies of open tabs).
2. Save the file as `cookies.txt` next to `docker-compose.yml` (it is gitignored).
3. In `docker-compose.yml`, uncomment the `volumes` block, and set
   `YTDLP_COOKIES=/cookies/cookies.txt` in `.env` / Portainer.
4. `docker compose up -d`

Using a secondary Google account is safer: heavy downloading with cookies can get the
account flagged.
