#!/bin/bash

set -e

# ---------------------- Configurable Paths ----------------------
BTBN_DIR="$common/ffmpeg-static"
TEMP_DIR="/tmp/ffmpeg-static"

# Constants
JELLYFIN_LINK="/usr/local/bin/ffmpeg"
JELLYFIN_DIR="/usr/lib/jellyfin-ffmpeg"
BTBN_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"

# ---------------------- Utility ------------------------
function handle_error {
    echo "An error occurred. Exiting..."
    exit 1
}

# ---------------------- Jellyfin FFmpeg ------------------------
function is_jellyfin_installed {
    [ -x "$JELLYFIN_LINK" ] && "$JELLYFIN_LINK" -version 2>/dev/null | grep -q jellyfin
}

function install_jellyfin_ffmpeg {
    if is_jellyfin_installed; then
        echo "Jellyfin FFmpeg is already installed."
        return
    fi

    echo "Installing Jellyfin FFmpeg..."

    architecture=$(uname -m)
    if [[ ! "$architecture" =~ ^(x86_64|aarch64|armv7l)$ ]]; then
        echo "Unsupported architecture: $architecture"
        exit 1
    fi

    curl -m 15 -fsSL https://repo.jellyfin.org/debian/jellyfin_team.gpg.key | gpg --dearmor --batch --yes -o /etc/apt/trusted.gpg.d/debian-jellyfin.gpg
    os_id=$(awk -F'=' '/^ID=/{ print $NF }' /etc/os-release)
    os_codename=$(awk -F'=' '/^VERSION_CODENAME=/{ print $NF }' /etc/os-release)
    echo "deb [arch=$(dpkg --print-architecture)] https://repo.jellyfin.org/$os_id $os_codename main" > /etc/apt/sources.list.d/jellyfin.list

    apt-get -qq update
    apt-get install --no-install-recommends --no-install-suggests -yqq jellyfin-ffmpeg7

    ln -sf "$JELLYFIN_DIR/ffmpeg" /usr/local/bin/ffmpeg
    ln -sf "$JELLYFIN_DIR/ffprobe" /usr/local/bin/ffprobe

    echo "Jellyfin FFmpeg installed."
}

function uninstall_jellyfin_ffmpeg {
    echo "Uninstalling Jellyfin FFmpeg..."
    rm -f /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
    apt-get remove --purge -y jellyfin-ffmpeg7 || echo "Not installed."
    rm -f /etc/apt/sources.list.d/jellyfin.list
    rm -f /etc/apt/trusted.gpg.d/debian-jellyfin.gpg /etc/apt/trusted.gpg.d/debian-jellyfin.gpg~
    apt-get update
}

# ---------------------- BtbN FFmpeg ------------------------
function install_btbn_ffmpeg {
    if is_btbn_installed; then
        echo "BtbN FFmpeg is already installed at $BTBN_DIR."
        return
    fi

    echo "Installing BtbN FFmpeg into $BTBN_DIR..."
    mkdir -p "$BTBN_DIR" "$TEMP_DIR"
    wget --no-verbose -O "$TEMP_DIR/ffmpeg-static.tar.xz" "$BTBN_URL"

    # Extract to temp directory first
    mkdir -p "$TEMP_DIR/extract"
    tar -xf "$TEMP_DIR/ffmpeg-static.tar.xz" -C "$TEMP_DIR/extract" --strip-components=1

    # Only keep ffmpeg and ffprobe binaries from bin/
    mkdir -p "$BTBN_DIR"
    cp "$TEMP_DIR/extract/bin/ffmpeg" "$BTBN_DIR/"
    cp "$TEMP_DIR/extract/bin/ffprobe" "$BTBN_DIR/"

    # Ensure executables
    chmod +x "$BTBN_DIR/ffmpeg" "$BTBN_DIR/ffprobe"

    # Cleanup temp
    rm -rf "$TEMP_DIR"

    echo "BtbN FFmpeg installed in $BTBN_DIR"
}

function is_btbn_installed {
    [ -x "$BTBN_DIR/ffmpeg" ] && [ -x "$BTBN_DIR/ffprobe" ]
}

function uninstall_btbn_ffmpeg {
    echo "Uninstalling BtbN FFmpeg from $BTBN_DIR..."
    rm -rf "$BTBN_DIR"
}

# ---------------------- Main Actions ------------------------
function install_all {
    if [ -z "$common" ]; then
        echo "❌ ERROR: \$common is not set. Please export it before running the script."
        exit 1
    fi

    echo "Installing to persistent path: $common"
    install_jellyfin_ffmpeg
    install_btbn_ffmpeg
    echo "✅ All components installed."
}

function uninstall_all {
    uninstall_jellyfin_ffmpeg
    uninstall_btbn_ffmpeg
    echo "🗑️ All components uninstalled."
}

# ---------------------- Entrypoint ------------------------
if [ "$1" == "--uninstall" ]; then
    uninstall_all
else
    install_all
fi

exit 0
