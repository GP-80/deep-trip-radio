#!/usr/bin/env python3
"""
DTR Music Server — serves current album cover and track metadata.
Port 8002. Stdlib only.

Endpoints:
  GET /cover  — JPEG of current album cover, or 404 if unknown
  GET /now    — JSON: title, artist, album, genre, year, license, url, label
"""
import json
import sqlite3
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

DB_PATH      = Path('/home/deeptripradio/music_db.sqlite')
LISTENER_DB  = Path('/home/deeptripradio/listener_data.sqlite')
ICECAST      = 'http://localhost:8000/status-json.xsl'
PORT         = 8002

_lock        = threading.Lock()
_ping_lock   = threading.Lock()
_ping_conn   = None

def _get_ping_conn():
    global _ping_conn
    if _ping_conn is None:
        _ping_conn = sqlite3.connect(str(LISTENER_DB), check_same_thread=False)
        _ping_conn.executescript('''
            CREATE TABLE IF NOT EXISTS pings (ts INTEGER, ip TEXT);
            CREATE INDEX IF NOT EXISTS pings_ts ON pings(ts);
        ''')
        _ping_conn.commit()
    return _ping_conn

def _record_ping(ip):
    if not ip or ip in ('127.0.0.1', '::1'):
        return
    now = int(time.time())
    with _ping_lock:
        conn = _get_ping_conn()
        conn.execute('INSERT INTO pings VALUES (?,?)', (now, ip))
        conn.execute('DELETE FROM pings WHERE ts < ?', (now - 7 * 86400,))
        conn.commit()
_cache_key   = None   # icecast_key currently loaded
_cache_cover = None   # JPEG bytes
_cache_meta  = {}     # track + album fields


def _icecast_title():
    try:
        with urllib.request.urlopen(ICECAST, timeout=4) as r:
            d = json.loads(r.read())
        src = d.get('icestats', {}).get('source', {})
        return src.get('title', '').strip()
    except Exception:
        return ''


def _lookup(key):
    """Return (cover_blob, meta_dict) for icecast_key, or (None, {})."""
    try:
        conn = sqlite3.connect(DB_PATH)
        row = conn.execute('''
            SELECT t.title, t.artist, a.album, a.genre, a.year,
                   a.license, a.url, a.cover_blob, a.label
            FROM   tracks t
            JOIN   albums a ON t.album_id = a.id
            WHERE  t.icecast_key = ?
            LIMIT  1
        ''', (key,)).fetchone()
        conn.close()
        if not row:
            return None, {}
        title, artist, album, genre, year, lic, url, cover, label = row
        meta = dict(title=title, artist=artist, album=album,
                    genre=genre, year=year, license=lic, url=url, label=label)
        return cover, meta
    except Exception:
        return None, {}


def _refresh(key):
    global _cache_key, _cache_cover, _cache_meta
    cover, meta = _lookup(key)
    with _lock:
        _cache_key   = key
        _cache_cover = cover
        _cache_meta  = meta


class Handler(BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass  # silence per-request logging

    def _sync(self):
        title = _icecast_title()
        if title and title != _cache_key:
            _refresh(title)

    def do_GET(self):
        self._sync()
        path = urlparse(self.path).path  # strip ?query

        if path == '/cover':
            with _lock:
                blob = _cache_cover
            if blob:
                self.send_response(200)
                self.send_header('Content-Type', 'image/jpeg')
                self.send_header('Content-Length', str(len(blob)))
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(blob)
            else:
                self.send_response(404)
                self.end_headers()

        elif path == '/listener-ping':
            ip = self.headers.get('X-Real-IP', '').strip()
            _record_ping(ip)
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            return

        elif path == '/now':
            with _lock:
                meta = dict(_cache_meta)
            body = json.dumps(meta, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)

        else:
            self.send_response(404)
            self.end_headers()


if __name__ == '__main__':
    print(f'DTR music server starting on port {PORT}')
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
