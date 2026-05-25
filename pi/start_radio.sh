#!/bin/bash

echo "$(date): Startup script started" >> /home/deeptripradio/startup.log

# Wait for USB to mount
sleep 30

# Find KINGSTON directory that actually has MP3 files
for i in {1..5}; do
    for dir in /media/deeptripradio/KINGSTON*; do
        if [ -d "$dir" ]; then
            # Check if this directory actually has MP3 files
            MP3_COUNT=$(find "$dir" -type f -iname "*.mp3" \
            -not -path "*/BASS MUSIC/*" \
            -not -path "*/EXPERIMENTAL/*" \
            -not -path "*/FULLON/*" \
            -not -path "*/GLITCH/*" \
            -not -path "*/IDM/*" \
            2>/dev/null | head -1 | wc -l)

            if [ "$MP3_COUNT" -gt 0 ]; then
                MUSIC_DIR="$dir"
                echo "$(date): Found USB with music at $MUSIC_DIR" >> /home/deeptripradio/startup.log
                break 2
            fi
        fi
    done

    echo "$(date): Waiting for USB with music (attempt $i/5)..." >> /home/deeptripradio/startup.log
    sleep 10
done

if [ -z "$MUSIC_DIR" ]; then
    echo "$(date): ERROR - No USB with MP3 files found" >> /home/deeptripradio/startup.log
    exit 1
fi

# Generate shuffled playlist
echo "$(date): Generating playlist..." >> /home/deeptripradio/startup.log
find "$MUSIC_DIR" -type f -iname "*.mp3" \
-not -path "*/BASS MUSIC/*" \
-not -path "*/EXPERIMENTAL/*" \
-not -path "*/FULLON/*" \
-not -path "*/GLITCH/*" \
-not -path "*/IDM/*" \
2>/dev/null | shuf > /home/deeptripradio/playlist.m3u

# Check playlist
SONG_COUNT=$(wc -l < /home/deeptripradio/playlist.m3u)
if [ "$SONG_COUNT" -eq 0 ]; then
    echo "$(date): ERROR - Playlist empty" >> /home/deeptripradio/startup.log
    exit 1
fi

echo "$(date): Playlist created with $SONG_COUNT songs" >> /home/deeptripradio/startup.log

# Wait for Icecast
sleep 5

# Start ezstream

echo "$(date): Deep Trip Radio started successfully" >> /home/deeptripradio/startup.log
