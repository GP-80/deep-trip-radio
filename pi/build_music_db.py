#!/usr/bin/env python3
"""
Build the DTR music database.

Walks KINGSTON1, extracts ID3 tags and cover art for every album,
downscales covers to 300x300 JPEG, and writes everything to SQLite.

Run on the Pi:
    python3 build_music_db.py

Output: /home/deeptripradio/music_db.sqlite
"""
import os
import io
import sqlite3
import logging
from pathlib import Path

import mutagen.id3
import mutagen.mp3
from PIL import Image

MUSIC_ROOT = Path('/media/deeptripradio/KINGSTON1')
DB_PATH    = Path('/home/deeptripradio/music_db.sqlite')
SKIP_DIRS  = {'System Volume Information'}
COVER_SIZE = (300, 300)
COVER_QUAL = 85   # JPEG quality

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger(__name__)


def downscale_cover(image_path):
    """Load, downscale, and return JPEG bytes. Returns None on failure."""
    try:
        with Image.open(image_path) as img:
            img = img.convert('RGB')
            img.thumbnail(COVER_SIZE, Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=COVER_QUAL, optimize=True)
            return buf.getvalue()
    except Exception as e:
        log.warning('Cover load failed %s: %s', image_path, e)
        return None


def find_cover(album_dir):
    """Return path to first image file in album folder, or None."""
    for ext in ('*.jpg', '*.jpeg', '*.png', '*.JPG', '*.JPEG', '*.PNG'):
        matches = list(album_dir.glob(ext))
        if matches:
            return matches[0]
    return None


def get_tag(tags, key):
    """Safely extract first value from an ID3 tag."""
    val = tags.get(key)
    if val is None:
        return ''
    try:
        return str(val.text[0]).strip()
    except Exception:
        return str(val).strip()


def get_duration(mp3_path):
    """Return duration in seconds, or 0.0 on failure."""
    try:
        audio = mutagen.mp3.MP3(mp3_path)
        return round(audio.info.length, 1)
    except Exception:
        return 0.0


def init_db(conn):
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS albums (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            artist      TEXT,
            album       TEXT,
            year        TEXT,
            genre       TEXT,
            folder_path TEXT UNIQUE,
            cover_blob  BLOB,
            license     TEXT,
            url         TEXT
        );

        CREATE TABLE IF NOT EXISTS tracks (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            album_id     INTEGER REFERENCES albums(id),
            title        TEXT,
            artist       TEXT,
            icecast_key  TEXT,
            track_number INTEGER,
            duration_s   REAL,
            filename     TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_icecast_key ON tracks(icecast_key);
        CREATE INDEX IF NOT EXISTS idx_album_id    ON tracks(album_id);
    ''')
    conn.commit()


def process_album(conn, genre, album_dir):
    mp3s = sorted(album_dir.glob('*.mp3'))
    if not mp3s:
        return 0

    # Read tags from all tracks, derive album-level fields from first valid set
    album_name  = ''
    album_year  = ''
    album_artist = ''

    track_rows = []
    for mp3 in mp3s:
        try:
            tags = mutagen.id3.ID3(mp3)
        except Exception as e:
            log.warning('Tag read failed %s: %s', mp3.name, e)
            continue

        title   = get_tag(tags, 'TIT2')
        artist  = get_tag(tags, 'TPE1')
        alb     = get_tag(tags, 'TALB')
        trck    = get_tag(tags, 'TRCK').split('/')[0]
        year    = get_tag(tags, 'TDRC')

        if not album_name and alb:
            album_name = alb
        if not album_year and year:
            album_year = year
        if not album_artist and artist:
            album_artist = artist

        icecast_key = f'{artist} - {title}' if artist else title
        track_number = int(trck) if trck.isdigit() else 0
        duration = get_duration(mp3)

        track_rows.append((title, artist, icecast_key, track_number, duration, mp3.name))

    if not track_rows:
        return 0

    # Cover
    cover_path = find_cover(album_dir)
    cover_blob = downscale_cover(cover_path) if cover_path else None
    if not cover_blob:
        log.warning('No cover: %s', album_dir.name)

    # Insert album
    cur = conn.execute(
        'INSERT OR IGNORE INTO albums (artist, album, year, genre, folder_path, cover_blob) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (album_artist, album_name, album_year, genre, str(album_dir), cover_blob)
    )
    album_id = cur.lastrowid
    if not album_id:
        album_id = conn.execute(
            'SELECT id FROM albums WHERE folder_path = ?', (str(album_dir),)
        ).fetchone()[0]

    # Insert tracks
    conn.executemany(
        'INSERT INTO tracks (album_id, title, artist, icecast_key, track_number, duration_s, filename) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [(album_id, *row) for row in track_rows]
    )
    conn.commit()
    return len(track_rows)


def main():
    if DB_PATH.exists():
        DB_PATH.unlink()
        log.info('Removed existing DB')

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    total_albums = 0
    total_tracks = 0

    for genre_dir in sorted(MUSIC_ROOT.iterdir()):
        if not genre_dir.is_dir() or genre_dir.name in SKIP_DIRS:
            continue
        genre = genre_dir.name
        log.info('Genre: %s', genre)

        for album_dir in sorted(genre_dir.iterdir()):
            if not album_dir.is_dir():
                continue
            n = process_album(conn, genre, album_dir)
            if n:
                total_albums += 1
                total_tracks += n
                log.info('  [%d tracks] %s', n, album_dir.name)

    conn.close()
    db_mb = round(DB_PATH.stat().st_size / 1_048_576, 1)
    log.info('Done — %d albums, %d tracks, DB = %s MB', total_albums, total_tracks, db_mb)


if __name__ == '__main__':
    main()
