# Deep Trip Radio — Changelog

## 2026-06-09

### Website (`deep-trip-radio-JUNE2026-v1.zip`)

**Routing rework — cloudflared → nginx → icecast/music_server**

Previously cloudflared routed `stream.deeptripradio.net` directly to icecast `:8000`. It now routes to nginx `:8080`, which handles all endpoints:

| Path | Backend |
|---|---|
| `/live` | icecast `:8000/live` |
| `/status-json.xsl` | icecast `:8000/status-json.xsl` |
| `/api/now` | music_server `:8002/now` |
| `/api/cover` | music_server `:8002/cover` |
| `/*` | `444` (connection closed) |

This unlocks the music server as a public API endpoint without exposing it on the local network.

**CORS duplicate header fix**

Both icecast and `music_server.py` emit `Access-Control-Allow-Origin: *`. Without intervention, nginx stacks a second header and browsers reject the response. Added `proxy_hide_header` for all backend CORS headers in every nginx proxy location. Verified with `curl -s -D - <url> | grep -c "Access-Control-Allow-Origin"` — count must be 1 for all endpoints.

**assets/p.js**
- Now fetches `/api/now` first for rich metadata: title, artist, album, Ektoplazm link, license
- Falls back to icecast `/status-json.xsl` for title/artist when current track is not in the music DB
- Album cover loads from `/api/cover`; fades out/in on track change (CSS `transition: opacity`; JS sets opacity 0, waits 320 ms if cover was visible, loads new src, double-RAF to trigger transition)
- `onerror` on cover img hides it gracefully; `currentTrackKey` prevents redundant fetches on unchanged tracks
- `?v=20260609` version string

**index.html**
- `.album-cover-container` moved out of `.track-info` to be a flex sibling of `.now-playing-left`; cover now top-aligns with the "Now Playing" label instead of bottom-aligning with the track details
- Long track/artist names truncate with `…` before reaching the cover image (requires `min-width:0` on all flex ancestors)
- `?v=20260609` version string

**assets/s.css**
- `.now-playing` is now a flex row (`display:flex; align-items:flex-start; gap:14px`)
- `.now-playing-left` added: `flex:1; min-width:0` (enables ellipsis truncation on children)
- `.album-cover-container` base: removed `align-self:flex-end`, `margin-bottom:-4px`, `margin-left:10px`
- Mobile: `.now-playing` collapses to column; `.now-playing-left` goes full width; cover centered below track info

### Pi Stack

**New files:**
- `pi/music_server.py` — lightweight HTTP server (stdlib only, `127.0.0.1:8002`); polls icecast for current title, looks it up in `music_db.sqlite`, serves JSON metadata (`/now`) and JPEG cover art (`/cover`). Query strings stripped from paths so cache-busting params don't break routing.
- `pi/build_music_db.py` — builds `music_db.sqlite` from KINGSTON1 (ID3 tags + cover art downscaled to 300×300 JPEG via `mutagen` + `Pillow`). Current DB: 342 albums, 2524 tracks, ~9.7 MB.
- `pi/music-server.service` — systemd unit; `music_server.py` starts automatically on boot with `Restart=always`
- `pi/nginx-icecast-proxy` — nginx site config (port 8080) with `proxy_hide_header` CORS pattern

**Pending:** Ektoplazm scraper to populate `license` and `url` columns in `music_db.sqlite` (currently null for all 342 albums).

---

## 2026-05-22

### Website (`deep-trip-radio-MAY2026-v4.zip`)

**assets/p.js**
- Added stall watchdog (`startStallCheck` / `stopStallCheck`)
  - Root cause of "LIVE but no audio" state: when the HTTP/2 stream connection dies silently after `onplay` has fired, the browser enters a `waiting`/`stalled` state on the audio element — but Howler has no callbacks for these native events. The result is the player showing "Live" (metadata poll unaffected) while audio is frozen indefinitely, with no automatic recovery.
  - Fix: polls `sound.seek()` every 5s while playing. `currentTime` advances in real-time during normal playback and freezes during a stall. If two consecutive readings are identical, stall is confirmed — sound is unloaded and `scheduleReconnect()` is triggered.
  - Worst-case silent time before recovery: ~16s (burst buffer drain at 128kbps) + up to 5s (poll interval) = ~21s. Infinite silence without this fix.
  - Zero load on the Pi — runs entirely in the browser, no network requests.
  - `stopStallCheck()` wired into all exit paths (`onpause`, `onstop`, `onloaderror`) to prevent orphaned intervals across reconnect cycles.
- Fixed Error state: clicking play after exhausting MAX_RECONNECT now works
  - Previously: when `reconnectAttempts >= MAX_RECONNECT`, the Error branch showed "Error" but left `sound` intact and `reconnectAttempts` at 20. Clicking play called `sound.play()` on the stale broken Howl, immediately hit another `onloaderror`, re-entered the Error branch, and showed Error again. Clicking play was a no-op — page refresh was required.
  - Fix: split the `if(userPaused||reconnectAttempts>=MAX_RECONNECT)` condition into two separate branches. The `>= MAX_RECONNECT` branch now unloads sound, resets `reconnectAttempts=0`, then shows Error. Clicking play afterwards creates a fresh Howl and starts a new 20-attempt cycle.
  - The `userPaused` branch is unchanged — no unload or reset when the user deliberately stopped the stream.
- `?v=20260522` version string added to `<script src="assets/p.js">` tag in `index.html`

---

## 2026-05-20

### Cloudflare

**HTTP/3 (QUIC) disabled on Cloudflare zone**
- Disabled via Cloudflare dashboard: Speed → Optimization → Protocol Optimization → HTTP/3 (with QUIC) → Off
  - Chrome attempts QUIC (HTTP/3, UDP-based) first for HTTPS connections. For long-lived audio streams, QUIC is unreliable — routers drop idle-looking UDP state the same way they drop UDP tunnel connections. Symptom: `ERR_QUIC_PROTOCOL_ERROR` in browser console, audio silent, but LIVE indicator still active (metadata polling uses short stateless requests that fall back gracefully; the long-lived audio stream connection does not).
  - With HTTP/3 off, browsers use HTTP/2 (TCP) for all connections to `stream.deeptripradio.net` — same stable protocol used by the Pi-side cloudflared tunnel. Does not affect the cloudflared tunnel itself.
  - Auto-reconnect would have eventually recovered the audio (up to ~30s delay at later retry steps), but disabling QUIC prevents the failure entirely.

---

## 2026-05-19

### Raspberry Pi (DTR)

**WiFi channel**
- Changed [home router] from channel 11 (manual) to channel 1
  - Channel scan via Pi showed channel 11 receiving bleed from channels 9, 10, and 13 (4 neighboring networks). Channel 1 had only 1 neighboring network and is furthest from the congested 9–13 band. Retry rate dropped from 100–170/30s to 34–65/30s after the change. Signal improved from -65 dBm to -52 dBm at same physical location.

**Android Chrome — background network restriction**
- Root cause of phone-specific stream drops identified: Android restricts network access for background browser tabs ~5 minutes after screen-off
  - Cloudflare's `context canceled` errors were being triggered by Android terminating the TCP connection from the client side, not by Cloudflare resetting it
  - Fix: Settings → Apps → Chrome → Battery → Unrestricted. Prevents Android from killing Chrome's network connections in the background.

**Diagnostics monitor script**
- Created `~/dtr_monitor.sh` on the Pi — a self-contained background monitoring script
  - Location: `/home/deeptripradio/dtr_monitor.sh`
  - Data written to: `~/dtr_monitor_data/` (created on start, safe to delete)
  - Not wired into cron or systemd — starts and stops manually only
  - Commands:
    - `bash dtr_monitor.sh start` — run in background
    - `bash dtr_monitor.sh stop` — stop background instance
    - `bash dtr_monitor.sh status` — show running state + latest readings
    - `bash dtr_monitor.sh report` — dump last 20 lines from all logs
  - Monitors 6 things in parallel, each in its own subshell:
    - **stream** (every 10s): icecast listener count, source up/down, current track title — alerts on listener drops or source disconnect
    - **tunnel** (every 15s): cloudflared HA connection count, error/warning rate from journald — alerts on any ERR entries
    - **wifi** (every 30s): signal level (dBm), link quality, retry delta, cumulative retries, rx/tx MB — alerts on retry spikes >5000/30s
    - **system** (every 60s): CPU temp, load average, RAM/swap usage, ezstream alive check — alerts if ezstream is dead
    - **network** (every 60s): ping latency + loss to 1.1.1.1, DNS resolution time for Cloudflare edge hostname, icecast HTTP status and response time
    - **cf_tail** (continuous): tails cloudflared journal in real time, captures ERR/WRN/reconnect events to alerts log
  - Logs rotate at 5MB each; total storage grows at ~300–600KB/hr depending on listener count
  - To clean up: `bash dtr_monitor.sh stop && rm -rf ~/dtr_monitor_data/`

---

## 2026-05-18

### Raspberry Pi (DTR) — applied live, no reboot required

**WiFi power management**
- Disabled WiFi PSM (Power Save Mode) permanently via systemd service `wifi-power-save-disable`
  - Linux enables PSM by default on wireless interfaces regardless of traffic load. The brcmfmac chip on the Pi Zero W would periodically doze between TCP ACKs, causing intermittent DNS resolution timeouts (`lookup region1.v2.argotunnel.com: i/o timeout` in cloudflared logs) and occasional cloudflared tunnel degradation
  - Service runs `iwconfig wlan0 power off` at boot, after `network-online.target`
  - Unit file: `/etc/systemd/system/wifi-power-save-disable.service`

**DNS persistence** (`/etc/dhcpcd.conf`)
- Added `static domain_name_servers=1.1.1.1 8.8.8.8 9.9.9.9`
  - Previously the static resolvers in `/etc/resolv.conf` were written directly and would be overwritten by dhcpcd on DHCP lease renewal, restoring whatever DNS the router provides. Static declaration in dhcpcd.conf survives lease renewals

**Root cause investigation — stream interruptions**
- Every listener drop in icecast logs (`listener count on /live now 0`) corresponds exactly to a `context canceled` / `Failed to proxy HTTP` error in cloudflared logs — confirmed by timestamp correlation
- Source (ezstream) never disconnects; all drops are at the listener/proxy layer
- Cloudflare's edge periodically resets HTTP/2 streams on long-lived audio connections — this is the direct cause of each interruption. The player's auto-reconnect handles it; listener count returns to normal within 1–2 seconds in most cases
- The "Error" state on the website (after exhausting all reconnect attempts) was caused by clustered drops during periods of WiFi/DNS instability, now addressed above

**icecast2** (`/etc/icecast2/icecast.xml`) — reloaded, no listener drop
- Collapsed three duplicate `<http-headers>` blocks into one
  - icecast.xml had accumulated three separate `<http-headers>` blocks over time, each emitting `Access-Control-Allow-Origin: *`. When requests carry an `Origin` header (as all browser CORS fetches do), Cloudflare passes all three headers through verbatim. Browsers reject responses with duplicate `Access-Control-Allow-Origin` headers, silently failing the metadata fetch. Tailscale Funnel was deduplicating them, masking the bug. Fixed to a single block with `GET, OPTIONS, HEAD` and minimal headers.

**tailscaled**
- Disabled permanently (`systemctl disable --now tailscaled`)
  - Audio and metadata both now go through the Cloudflare tunnel. Tailscale is no longer a dependency for anything.

**ezstream** — requires reboot to take effect
- Moved from unmanaged background process (cron `@reboot`) to systemd service with `Restart=always`
  - ezstream had no watchdog — a crash would silence the stream indefinitely until manual SSH intervention. Now systemd restarts it within 10s of any exit
  - `ExecStartPre` waits until `playlist.m3u` is non-empty (generated by `start_radio.sh`) before starting, handling the USB mount delay at boot
  - `TimeoutStartSec=300` prevents systemd from giving up during slow USB detection
  - Unit file: `/etc/systemd/system/ezstream.service`
- Removed ezstream launch from `~/start_radio.sh`
  - `start_radio.sh` now only handles USB detection and playlist generation; ezstream lifecycle is fully owned by systemd

---

### Website (`deep-trip-radio-MAY2026-v3.zip`)

**index.html**
- Added `?v=20260518` version string to `<script src="assets/p.js">` tag
  - Cloudflare CDN was caching `assets/p.js` for 7 days (origin sets `s-maxage=604800`). New Pages deployments update the origin but the CDN serves the stale cached copy. Versioning the URL forces a cache miss on every deployment without needing a manual cache purge.

**assets/p.js**
- `MAX_RECONNECT` raised from 10 to 20
  - With Cloudflare resetting HTTP/2 streams periodically, the player needs more headroom before giving up and showing "Error". 20 attempts gives ~8 minutes of retry time (exponential backoff: 2s → 4s → 8s → 16s → 30s max) vs ~3.5 minutes previously
- `METADATA_URL` confirmed as `https://stream.deeptripradio.net/status-json.xsl`
  - Audio and metadata both through Cloudflare tunnel; Tailscale no longer referenced anywhere

---

## 2026-05-17

### Raspberry Pi (DTR) — applied live, no reboot required

**cloudflared**
- Switched tunnel protocol from QUIC to HTTP/2 (`protocol: http2` in `~/.cloudflared/config.yml`)
  - QUIC is UDP-based; home router NAT was expiring idle UDP state, causing all 4 tunnel connections to drop simultaneously for 2–3 minutes. HTTP/2 over TCP does not have this failure mode.
- Added `--no-autoupdate` flag to service ExecStart and config
  - cloudflared was attempting a daily auto-update but failing silently (`permission denied` on `/usr/local/bin/`), producing noise in logs

**DNS**
- Disabled Tailscale DNS override (`tailscale set --accept-dns=false`)
- Set static public resolvers: `1.1.1.1`, `8.8.8.8`, `9.9.9.9`
  - Previously `/etc/resolv.conf` was controlled entirely by Tailscale. During a Tailscale DNS outage (confirmed May 15), cloudflared could not resolve Cloudflare edge IPs, compounding the tunnel outage. Public DNS fallback prevents this cascading failure.

**icecast2** (`/etc/icecast2/icecast.xml`) — reloaded, no listener drop
- `source-timeout` raised from 10s to 30s
  - ezstream/libshout stalls briefly between tracks while reading the next file from USB storage. At 10s icecast was disconnecting all listeners before ezstream resumed. 30s gives enough headroom.
- `burst-size` doubled from 131072 to 262144 bytes (~16s at 128kbps)
  - Listeners reconnecting after any drop now buffer up faster and hear audio sooner.

**tailscaled**
- Re-enabled after being prematurely stopped
  - The live website's `p.js` had `METADATA_URL` pointing to Tailscale Funnel — tailscaled had to remain running for metadata to work
  - Audio goes through the Cloudflare tunnel; metadata was continuing through Tailscale Funnel at this point

---

### Website (`deep-trip-radio-MAY_2026.zip`)

**assets/p.js**
- `METADATA_URL` migrated from Tailscale Funnel to `https://stream.deeptripradio.net/status-json.xsl` (Cloudflare tunnel)
  - Audio and metadata now share the same tunnel. Tailscale is no longer a dependency for anything the website does. CORS headers already present in icecast config.
- Auto-reconnect logic added
  - On stream drop (`onloaderror` or unexpected `onstop`), player shows "Reconnecting…" and retries automatically with exponential backoff (2s → 4s → 8s → … → 30s max, up to 10 attempts)
  - User-initiated pause (`userPaused` flag) correctly suppresses reconnect — only unintended drops trigger it
  - On successful reconnect, attempt counter resets
