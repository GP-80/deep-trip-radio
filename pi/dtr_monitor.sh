#!/usr/bin/env bash
# dtr_monitor.sh — Deep Trip Radio diagnostics monitor
#
# Usage:
#   ./dtr_monitor.sh          run in foreground (Ctrl+C to stop)
#   ./dtr_monitor.sh start    run in background
#   ./dtr_monitor.sh stop     stop background instance
#   ./dtr_monitor.sh status   show running state + latest readings
#   ./dtr_monitor.sh report   dump recent data from all logs
#
# All data written to ./dtr_monitor_data/
# To clean up: stop the monitor, then  rm -rf dtr_monitor_data/

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/dtr_monitor_data"
PID_FILE="$DATA_DIR/monitor.pid"

LOG_STREAM="$DATA_DIR/stream.log"
LOG_TUNNEL="$DATA_DIR/tunnel.log"
LOG_WIFI="$DATA_DIR/wifi.log"
LOG_SYSTEM="$DATA_DIR/system.log"
LOG_NET="$DATA_DIR/network.log"
LOG_ALERTS="$DATA_DIR/alerts.log"

MAX_BYTES=$(( 5 * 1024 * 1024 ))

ICECAST_URL="http://localhost:8000/status-json.xsl"
STREAM_URL="https://stream.deeptripradio.net/live"
CF_METRICS="http://127.0.0.1:20241/metrics"

ts() { date '+%Y-%m-%dT%H:%M:%S'; }

wlog() {
    local f="$1"; shift
    if [[ -f "$f" ]] && (( $(stat -c%s "$f" 2>/dev/null || echo 0) > MAX_BYTES )); then
        mv "$f" "${f%.log}.$(date +%Y%m%d_%H%M%S).old"
    fi
    printf '%s %s\n' "$(ts)" "$*" >> "$f"
}

alert() {
    wlog "$LOG_ALERTS" "ALERT $*"
    {
        printf '  cf> '
        journalctl -u cloudflared --no-pager -n 4 -q 2>/dev/null | tr '\n' '|'
        printf '\n'
    } >> "$LOG_ALERTS"
}

mon_stream() {
    local prev_l="-1" prev_src="?"
    while true; do
        local raw l src title
        raw=$(curl -sf --max-time 4 "$ICECAST_URL" 2>/dev/null || echo "")
        if [[ -z "$raw" ]]; then
            wlog "$LOG_STREAM" "icecast=UNREACHABLE"
            alert "icecast_unreachable"
        else
            l=$(printf '%s' "$raw" | python3 -c "
import sys,json
try:
 d=json.load(sys.stdin); s=d.get('icestats',{}).get('source')
 print(s.get('listeners','0') if isinstance(s,dict) else '0')
except: print('?')
" 2>/dev/null || echo "?")
            src=$(printf '%s' "$raw" | python3 -c "
import sys,json
try:
 d=json.load(sys.stdin)
 print('up' if d.get('icestats',{}).get('source') else 'down')
except: print('?')
" 2>/dev/null || echo "?")
            title=$(printf '%s' "$raw" | python3 -c "
import sys,json
try:
 d=json.load(sys.stdin); s=d.get('icestats',{}).get('source',{})
 print((s.get('title','') if isinstance(s,dict) else '')[:55])
except: print('')
" 2>/dev/null || echo "")
            wlog "$LOG_STREAM" "listeners=$l source=$src title=\"$title\""
            [[ "$prev_l" != "-1" && "$prev_l" != "0" && "$l" == "0" ]] && \
                alert "listener_drop prev=$prev_l now=0 src=$src title=\"$title\""
            [[ "$prev_src" == "up" && "$src" == "down" ]] && \
                alert "source_disconnect ezstream lost icecast connection"
            prev_l="$l"; prev_src="$src"
        fi
        sleep 10
    done
}

mon_tunnel() {
    while true; do
        local ha errs warns ctx
        ha=$(curl -sf --max-time 2 "$CF_METRICS" 2>/dev/null \
            | awk '/^cloudflared_tunnel_ha_connections /{print $2}' || echo "?")
        errs=$(journalctl -u cloudflared --no-pager --since "20 seconds ago" -q 2>/dev/null \
            | grep -c " ERR " || echo 0)
        warns=$(journalctl -u cloudflared --no-pager --since "20 seconds ago" -q 2>/dev/null \
            | grep -c " WRN " || echo 0)
        wlog "$LOG_TUNNEL" "ha_connections=$ha errors_20s=$errs warnings_20s=$warns"
        if (( errs > 0 )); then
            ctx=$(journalctl -u cloudflared --no-pager --since "20 seconds ago" -q 2>/dev/null \
                | grep " ERR " | tail -2 | tr '\n' '|')
            alert "tunnel_errors count=$errs | $ctx"
        fi
        sleep 15
    done
}

mon_wifi() {
    local prev_r
    prev_r=$(awk '/wlan0/{gsub(/\./,"",$9); print $9+0}' /proc/net/wireless 2>/dev/null || echo 0)
    while true; do
        local link lvl retries delta rx tx
        read -r link lvl retries < <(awk '/wlan0/{
            gsub(/\./,"",$3); gsub(/\./,"",$4); gsub(/\./,"",$9)
            print $3+0, $4+0, $9+0
        }' /proc/net/wireless 2>/dev/null || echo "0 0 0")
        delta=$(( retries - prev_r )); prev_r=$retries
        rx=$(( $(cat /sys/class/net/wlan0/statistics/rx_bytes 2>/dev/null || echo 0) / 1048576 ))
        tx=$(( $(cat /sys/class/net/wlan0/statistics/tx_bytes 2>/dev/null || echo 0) / 1048576 ))
        wlog "$LOG_WIFI" "link=$link level=${lvl}dBm retry_delta=$delta retry_total=$retries rx_MB=$rx tx_MB=$tx"
        (( delta > 5000 )) && alert "wifi_retry_spike delta=$delta/30s"
        sleep 30
    done
}

mon_system() {
    while true; do
        local temp load mu mt sw ez
        temp=$(vcgencmd measure_temp 2>/dev/null | grep -oP '[\d.]+' \
            || awk '{printf "%.1f",$1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null \
            || echo "?")
        load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null | tr ' ' '/')
        read -r mt mu < <(free -m 2>/dev/null | awk '/^Mem:/{print $2,$3}')
        sw=$(free -m 2>/dev/null | awk '/^Swap:/{print $3}')
        pgrep -x ezstream > /dev/null 2>&1 && ez="running" \
            || { ez="DEAD"; alert "ezstream_dead stream is silent"; }
        wlog "$LOG_SYSTEM" "temp=${temp}C load=$load ram=${mu}/${mt}MB swap=${sw}MB ezstream=$ez"
        sleep 60
    done
}

mon_network() {
    while true; do
        local pout ms loss t0 t1 dns_ms code icecast_ms
        pout=$(ping -c 3 -W 3 1.1.1.1 2>/dev/null || echo "")
        ms=$(echo "$pout" | grep -oP 'rtt[^=]+=\s*[\d.]+/\K[\d.]+' || echo "?")
        loss=$(echo "$pout" | grep -oP '\d+(?=% packet loss)' || echo "100")
        t0=$(date +%s%3N)
        dig +short +time=3 region1.v2.argotunnel.com @1.1.1.1 >/dev/null 2>&1 || true
        t1=$(date +%s%3N); dns_ms=$(( t1 - t0 ))
        t0=$(date +%s%3N)
        code=$(curl -sf --max-time 4 -o /dev/null -w "%{http_code}" \
            "$ICECAST_URL" 2>/dev/null || echo "fail")
        t1=$(date +%s%3N); icecast_ms=$(( t1 - t0 ))
        wlog "$LOG_NET" "ping=${ms}ms loss=${loss}% dns_edge=${dns_ms}ms icecast_http=$code icecast_ms=${icecast_ms}ms"
        [[ "$loss" == "100" ]] && alert "internet_unreachable 100pct loss to 1.1.1.1"
        [[ "$code" != "200" ]] && alert "icecast_unreachable http=$code latency=${icecast_ms}ms"
        sleep 60
    done
}

mon_cf_tail() {
    journalctl -u cloudflared -f --no-pager -q 2>/dev/null \
    | grep --line-buffered -E "(ERR|WRN|Registered tunnel|Connection terminated|Retrying)" \
    | while IFS= read -r line; do
        wlog "$LOG_ALERTS" "CF: $line"
    done
}

do_run() {
    mkdir -p "$DATA_DIR"
    echo $$ > "$PID_FILE"
    for f in "$LOG_ALERTS" "$LOG_STREAM" "$LOG_TUNNEL" "$LOG_WIFI" "$LOG_SYSTEM" "$LOG_NET"; do
        wlog "$f" "=== monitor started pid=$$ ==="
    done
    trap 'wlog "$LOG_ALERTS" "monitor stopped"; kill 0; exit 0' INT TERM
    mon_stream  &
    mon_tunnel  &
    mon_wifi    &
    mon_system  &
    mon_network &
    mon_cf_tail &
    wait
}

case "${1:-run}" in
    start)
        mkdir -p "$DATA_DIR"
        if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "Already running (pid $(cat "$PID_FILE"))"; exit 1
        fi
        nohup bash "$0" run > "$DATA_DIR/stdout.log" 2>&1 &
        echo $! > "$PID_FILE"
        echo "Started (pid $!). Data in $DATA_DIR/"
        ;;
    stop)
        if [[ -f "$PID_FILE" ]]; then
            pid=$(cat "$PID_FILE")
            pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ') || pgid=""
            if [[ -n "$pgid" && "$pgid" != "0" ]]; then
                kill -- -"$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
            else
                kill "$pid" 2>/dev/null || true
            fi
            rm -f "$PID_FILE"
            echo "Stopped."
        else
            echo "Not running."
        fi
        ;;
    status)
        if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
            echo "RUNNING (pid $(cat "$PID_FILE"))"
        else
            echo "NOT RUNNING"
        fi
        echo ""
        echo "── stream (last 3) ──";  tail -3 "$LOG_STREAM"  2>/dev/null || echo "(no data)"
        echo "── tunnel (last 3) ──";  tail -3 "$LOG_TUNNEL"  2>/dev/null || echo "(no data)"
        echo "── alerts (last 5) ──";  tail -5 "$LOG_ALERTS"  2>/dev/null || echo "(no data)"
        ;;
    report)
        for pair in "ALERTS:$LOG_ALERTS" "STREAM:$LOG_STREAM" "TUNNEL:$LOG_TUNNEL" \
                    "WIFI:$LOG_WIFI" "NETWORK:$LOG_NET" "SYSTEM:$LOG_SYSTEM"; do
            label="${pair%%:*}"; log="${pair#*:}"
            echo "══ $label (last 20) ══"
            tail -20 "$log" 2>/dev/null || echo "(no data)"
            echo ""
        done
        ;;
    run|*)
        do_run
        ;;
esac