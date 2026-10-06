#!/usr/bin/env python3
"""
Add a label catalogue to the existing DTR music database (add-only).

Unlike build_music_db.py this never deletes the DB, so url/license data already
filled in for other labels is preserved. Albums whose folder is already in the
DB are skipped, so it is safe to re-run after adding more releases.

Expected layout (one folder per release, optionally with Disc N subfolders):

    <ROOT>/<release folder>/<album folder>/*.mp3
    <ROOT>/<release folder>/<album folder>/Disc 1/*.mp3

Release metadata comes from a JSON file in <ROOT>: a list of objects with
"folder" (release folder name), "release_url", "license" and "genre".
Cover art is the first "00 - Cover*.jpg" found in the track folder or its
parents up to the release folder.

Run on the Pi:
    python3 add_label_db.py --root /media/deeptripradio/KINGSTON1/BLOCSONIC \
        --meta blocsonic_downtempo.json --label blocSonic
"""
import argparse
import json
import shutil
import sqlite3
from pathlib import Path

import mutagen.id3

from build_music_db import DB_PATH, downscale_cover, get_tag, get_duration, init_db, log


def find_cover(track_dir, release_dir):
    d = track_dir
    while True:
        covers = sorted(p for p in d.glob('00 - Cover*.jpg') if not p.name.startswith('._'))
        if covers:
            return covers[0]
        if d == release_dir or d.parent == d:
            return None
        d = d.parent


def process_dir(conn, track_dir, release_dir, meta, label):
    if conn.execute('SELECT 1 FROM albums WHERE folder_path = ?', (str(track_dir),)).fetchone():
        log.info('  already in DB, skipping: %s', track_dir.name)
        return 0

    mp3s = sorted(p for p in track_dir.glob('*.mp3') if not p.name.startswith('._'))
    album_name = album_year = album_artist = ''
    track_rows = []
    for mp3 in mp3s:
        try:
            tags = mutagen.id3.ID3(mp3)
        except Exception as e:
            log.warning('Tag read failed %s: %s', mp3.name, e)
            continue
        title  = get_tag(tags, 'TIT2')
        artist = get_tag(tags, 'TPE1')
        alb    = get_tag(tags, 'TALB')
        trck   = get_tag(tags, 'TRCK').split('/')[0]
        year   = get_tag(tags, 'TDRC')
        album_name   = album_name or alb
        album_year   = album_year or year
        album_artist = album_artist or artist
        icecast_key = f'{artist} - {title}' if artist else title
        track_rows.append((title, artist, icecast_key,
                           int(trck) if trck.isdigit() else 0, get_duration(mp3), mp3.name))
    if not track_rows:
        return 0

    cover_path = find_cover(track_dir, release_dir)
    cover_blob = downscale_cover(cover_path) if cover_path else None
    if not cover_blob:
        log.warning('No cover: %s', track_dir)

    cur = conn.execute(
        'INSERT INTO albums (artist, album, year, genre, folder_path, cover_blob, license, url, label) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (album_artist, album_name, album_year, (meta.get('genre') or '').upper(), str(track_dir),
         cover_blob, meta.get('license'), meta.get('release_url'), label))
    conn.executemany(
        'INSERT INTO tracks (album_id, title, artist, icecast_key, track_number, duration_s, filename) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        [(cur.lastrowid, *row) for row in track_rows])
    conn.commit()
    return len(track_rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--root', required=True, type=Path, help='label folder on the USB drive')
    ap.add_argument('--meta', required=True, help='release metadata JSON (relative to --root)')
    ap.add_argument('--label', required=True, help='label name shown on the website ("View on <label>")')
    args = ap.parse_args()

    releases = {e['folder']: e for e in json.loads((args.root / args.meta).read_text(encoding='utf-8'))}

    backup = DB_PATH.with_suffix('.sqlite.bak')
    shutil.copy2(DB_PATH, backup)
    log.info('Backed up DB to %s', backup)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)
    total_albums = total_tracks = 0
    for release_dir in sorted(p for p in args.root.iterdir() if p.is_dir()):
        meta = releases.get(release_dir.name)
        if meta is None:
            log.warning('No metadata for %s, skipping', release_dir.name)
            continue
        track_dirs = sorted({p.parent for p in release_dir.rglob('*.mp3') if not p.name.startswith('._')})
        for track_dir in track_dirs:
            n = process_dir(conn, track_dir, release_dir, meta, args.label)
            if n:
                total_albums += 1
                total_tracks += n
                log.info('  [%d tracks] %s', n, track_dir.relative_to(args.root))
    conn.close()
    log.info('Done: added %d albums, %d tracks (label %s)', total_albums, total_tracks, args.label)


if __name__ == '__main__':
    main()
