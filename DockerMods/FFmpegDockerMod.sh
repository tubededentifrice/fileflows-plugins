#!/bin/bash

set -e
set -o pipefail

# ---------------------- Configurable Paths ----------------------
BTBN_SUBDIR="ffmpeg-static"
TEMP_DIR="/tmp/ffmpeg-static"

# Constants
JELLYFIN_DIR="/usr/lib/jellyfin-ffmpeg"
JELLYFIN_FFMPEG="${JELLYFIN_DIR}/ffmpeg"
JELLYFIN_FFPROBE="${JELLYFIN_DIR}/ffprobe"

# BtbN FFmpeg builds (try in order). We prefer “gpl” builds (x264/x265 enabled).
BTBN_URL_CANDIDATES=(
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl-shared.tar.xz"
)

FFMPEG_WRAPPER="/usr/local/bin/ffmpeg"
FFPROBE_WRAPPER="/usr/local/bin/ffprobe"
FFMPEG_JELLYFIN="/usr/local/bin/ffmpeg.jellyfin"
FFPROBE_JELLYFIN="/usr/local/bin/ffprobe.jellyfin"
FFMPEG_BTBN="/usr/local/bin/ffmpeg.btbn"
FFPROBE_BTBN="/usr/local/bin/ffprobe.btbn"

# ---------------------- Utility ------------------------
function require_root {
    if [ "$(id -u)" -ne 0 ]; then
        echo "❌ ERROR: This script must be run as root inside the container."
        exit 1
    fi
}

function ensure_prereqs {
    if command -v apt-get >/dev/null 2>&1; then
        apt-get -qq update
        apt-get install --no-install-recommends --no-install-suggests -yqq \
            ca-certificates curl wget xz-utils gnupg

        # Best-effort runtime deps for QSV/VAAPI/OpenCL (varies by distro/driver stack).
        # Missing packages here should not block ffmpeg installation.
        set +e
        apt-get install --no-install-recommends --no-install-suggests -yqq \
            libdrm2 libva2 libva-drm2 libva-x11-2 \
            ocl-icd-libopencl1 mesa-opencl-icd \
            intel-media-va-driver i965-va-driver 2>/dev/null
        set -e
    fi
}

function get_btbn_dir {
    echo "${common}/${BTBN_SUBDIR}"
}

function run_ffmpeg_with_libs {
    local rootDir="$1"
    local ffmpegPath="$2"
    shift 2

    if [ -d "${rootDir}/lib" ]; then
        LD_LIBRARY_PATH="${rootDir}/lib:${LD_LIBRARY_PATH}" "${ffmpegPath}" "$@"
    else
        "${ffmpegPath}" "$@"
    fi
}

function ffmpeg_has_filter {
    local rootDir="$1"
    local ffmpegPath="$2"
    local filterName="$3"
    run_ffmpeg_with_libs "${rootDir}" "${ffmpegPath}" -hide_banner -filters 2>/dev/null | grep -qE "[[:space:]]${filterName}([[:space:]]|$)"
}

function ffmpeg_has_encoder {
    local rootDir="$1"
    local ffmpegPath="$2"
    local encoderName="$3"
    run_ffmpeg_with_libs "${rootDir}" "${ffmpegPath}" -hide_banner -encoders 2>/dev/null | grep -qE "[[:space:]]${encoderName}([[:space:]]|$)"
}

function ffmpeg_has_hwaccel {
    local rootDir="$1"
    local ffmpegPath="$2"
    local accelName="$3"
    run_ffmpeg_with_libs "${rootDir}" "${ffmpegPath}" -hide_banner -hwaccels 2>/dev/null | grep -qE "[[:space:]]${accelName}([[:space:]]|$)"
}

function ffmpeg_meets_fileflows_requirements {
    local rootDir="$1"
    local ffmpegPath="$2"

    ffmpeg_meets_cleaning_filters_requirements "${rootDir}" "${ffmpegPath}" || return 1
    ffmpeg_meets_auto_quality_requirements "${rootDir}" "${ffmpegPath}" || return 1
    ffmpeg_meets_hw_requirements "${rootDir}" "${ffmpegPath}" || return 1

    return 0
}

function ffmpeg_meets_cleaning_filters_requirements {
    local rootDir="$1"
    local ffmpegPath="$2"

    # Cleaning filters.js
    local requiredFilters=(idet vpp_qsv deinterlace_qsv hqdn3d deband gradfun hwdownload hwupload)

    local item
    for item in "${requiredFilters[@]}"; do
        ffmpeg_has_filter "${rootDir}" "${ffmpegPath}" "${item}" || return 1
    done

    return 0
}

function ffmpeg_meets_auto_quality_requirements {
    local rootDir="$1"
    local ffmpegPath="$2"

    # Auto quality.js
    local requiredFilters=(libvmaf ssim signalstats metadata)
    local requiredEncoders=(libx264 libx265 libsvtav1 ffv1)

    local item
    for item in "${requiredFilters[@]}"; do
        ffmpeg_has_filter "${rootDir}" "${ffmpegPath}" "${item}" || return 1
    done

    for item in "${requiredEncoders[@]}"; do
        ffmpeg_has_encoder "${rootDir}" "${ffmpegPath}" "${item}" || return 1
    done

    return 0
}

function ffmpeg_meets_hw_requirements {
    local rootDir="$1"
    local ffmpegPath="$2"

    # “Have everything enabled” in practice means the binary can do both QSV and VAAPI.
    local requiredHwaccels=(qsv vaapi)

    local item
    for item in "${requiredHwaccels[@]}"; do
        ffmpeg_has_hwaccel "${rootDir}" "${ffmpegPath}" "${item}" || return 1
    done

    # OpenCL support (requested; not directly required by the two scripts, but common in HW filter chains)
    ffmpeg_has_filter "${rootDir}" "${ffmpegPath}" "scale_opencl" || return 1

    return 0
}

# ---------------------- Jellyfin FFmpeg ------------------------
function is_jellyfin_installed {
    [ -x "${JELLYFIN_FFMPEG}" ] && "${JELLYFIN_FFMPEG}" -version 2>/dev/null | grep -q jellyfin
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

    echo "Jellyfin FFmpeg installed."
}

function uninstall_jellyfin_ffmpeg {
    echo "Uninstalling Jellyfin FFmpeg..."
    rm -f "${FFMPEG_JELLYFIN}" "${FFPROBE_JELLYFIN}"
    apt-get remove --purge -y jellyfin-ffmpeg7 || echo "Not installed."
    rm -f /etc/apt/sources.list.d/jellyfin.list
    rm -f /etc/apt/trusted.gpg.d/debian-jellyfin.gpg /etc/apt/trusted.gpg.d/debian-jellyfin.gpg~
    apt-get update
}

# ---------------------- BtbN FFmpeg ------------------------
function install_btbn_ffmpeg {
    local btbn_dir
    btbn_dir="$(get_btbn_dir)"

    if is_btbn_installed; then
        echo "BtbN FFmpeg is already installed at ${btbn_dir}."
        return
    fi

    architecture=$(uname -m)
    if [ "$architecture" != "x86_64" ]; then
        echo "Skipping BtbN FFmpeg install on unsupported architecture: ${architecture}"
        return
    fi

    echo "Installing BtbN FFmpeg into ${btbn_dir}..."
    rm -rf "${TEMP_DIR}"
    mkdir -p "${TEMP_DIR}/extract"

    local url
    local best_auto_url=""
    for url in "${BTBN_URL_CANDIDATES[@]}"; do
        echo "Trying BtbN build: ${url}"
        rm -f "${TEMP_DIR}/ffmpeg.tar.xz"

        if ! wget --no-verbose -O "${TEMP_DIR}/ffmpeg.tar.xz" "${url}"; then
            echo "Download failed, trying next build..."
            continue
        fi

        rm -rf "${TEMP_DIR}/extract"
        mkdir -p "${TEMP_DIR}/extract"
        if ! tar -xf "${TEMP_DIR}/ffmpeg.tar.xz" -C "${TEMP_DIR}/extract" --strip-components=1; then
            echo "Extract failed, trying next build..."
            continue
        fi

        if [ ! -x "${TEMP_DIR}/extract/bin/ffmpeg" ]; then
            echo "BtbN archive missing bin/ffmpeg, trying next build..."
            continue
        fi

        if ffmpeg_meets_fileflows_requirements "${TEMP_DIR}/extract" "${TEMP_DIR}/extract/bin/ffmpeg"; then
            rm -rf "${btbn_dir}"
            mkdir -p "${btbn_dir}"
            cp -a "${TEMP_DIR}/extract/." "${btbn_dir}/"
            ln -sf "${btbn_dir}/bin/ffmpeg" "${btbn_dir}/ffmpeg"
            ln -sf "${btbn_dir}/bin/ffprobe" "${btbn_dir}/ffprobe"
            chmod +x "${btbn_dir}/bin/ffmpeg" "${btbn_dir}/bin/ffprobe" 2>/dev/null || true
            rm -rf "${TEMP_DIR}"
            echo "BtbN FFmpeg installed in ${btbn_dir}"
            return
        fi

        if [ -z "${best_auto_url}" ] && ffmpeg_meets_auto_quality_requirements "${TEMP_DIR}/extract" "${TEMP_DIR}/extract/bin/ffmpeg"; then
            best_auto_url="${url}"
            echo "BtbN build meets Auto quality.js requirements; will use it if no all-in-one build is found."
        else
            echo "BtbN build does not meet Auto quality.js requirements, trying next build..."
        fi
    done

    if [ -n "${best_auto_url}" ]; then
        echo "No all-in-one BtbN build found; installing best Auto quality.js-capable build: ${best_auto_url}"
        rm -rf "${TEMP_DIR}"
        mkdir -p "${TEMP_DIR}/extract"
        if wget --no-verbose -O "${TEMP_DIR}/ffmpeg.tar.xz" "${best_auto_url}" \
            && tar -xf "${TEMP_DIR}/ffmpeg.tar.xz" -C "${TEMP_DIR}/extract" --strip-components=1 \
            && [ -x "${TEMP_DIR}/extract/bin/ffmpeg" ]; then
            rm -rf "${btbn_dir}"
            mkdir -p "${btbn_dir}"
            cp -a "${TEMP_DIR}/extract/." "${btbn_dir}/"
            ln -sf "${btbn_dir}/bin/ffmpeg" "${btbn_dir}/ffmpeg"
            ln -sf "${btbn_dir}/bin/ffprobe" "${btbn_dir}/ffprobe"
            chmod +x "${btbn_dir}/bin/ffmpeg" "${btbn_dir}/bin/ffprobe" 2>/dev/null || true
            rm -rf "${TEMP_DIR}"
            echo "BtbN FFmpeg installed in ${btbn_dir}"
            return
        fi
    fi

    echo "⚠️  BtbN FFmpeg could not be installed (continuing with Jellyfin only)."
    rm -rf "${TEMP_DIR}"
    return 0
}

function is_btbn_installed {
    local btbn_dir
    btbn_dir="$(get_btbn_dir)"
    [ -x "${btbn_dir}/ffmpeg" ] && [ -x "${btbn_dir}/ffprobe" ]
}

function uninstall_btbn_ffmpeg {
    local btbn_dir
    btbn_dir="$(get_btbn_dir)"
    echo "Uninstalling BtbN FFmpeg from ${btbn_dir}..."
    rm -rf "${btbn_dir}"
}

function install_link_wrappers {
    local btbn_dir
    btbn_dir="$(get_btbn_dir)"

    # Jellyfin shims
    if [ -x "${JELLYFIN_FFMPEG}" ]; then
        ln -sf "${JELLYFIN_FFMPEG}" "${FFMPEG_JELLYFIN}"
        ln -sf "${JELLYFIN_FFPROBE}" "${FFPROBE_JELLYFIN}"
    fi

    # BtbN shims (wrap to support shared builds with bundled libs)
    if [ -x "${btbn_dir}/bin/ffmpeg" ]; then
        cat >"${FFMPEG_BTBN}" <<EOF
#!/bin/bash
set -e
BTBN_DIR="${btbn_dir}"
if [ -d "\${BTBN_DIR}/lib" ]; then
  export LD_LIBRARY_PATH="\${BTBN_DIR}/lib:\${LD_LIBRARY_PATH}"
fi
exec "\${BTBN_DIR}/bin/ffmpeg" "\$@"
EOF
        chmod +x "${FFMPEG_BTBN}"
    fi

    if [ -x "${btbn_dir}/bin/ffprobe" ]; then
        cat >"${FFPROBE_BTBN}" <<EOF
#!/bin/bash
set -e
BTBN_DIR="${btbn_dir}"
if [ -d "\${BTBN_DIR}/lib" ]; then
  export LD_LIBRARY_PATH="\${BTBN_DIR}/lib:\${LD_LIBRARY_PATH}"
fi
exec "\${BTBN_DIR}/bin/ffprobe" "\$@"
EOF
        chmod +x "${FFPROBE_BTBN}"
    fi
}

function configure_default_ffmpeg {
    # Prefer a single ffmpeg binary that satisfies everything; otherwise install a simple selector wrapper.
    local jellyfin_ok=0
    local btbn_ok=0

    if [ -x "${FFMPEG_JELLYFIN}" ] && ffmpeg_meets_fileflows_requirements "${JELLYFIN_DIR}" "${FFMPEG_JELLYFIN}"; then
        jellyfin_ok=1
    fi
    if [ -x "${FFMPEG_BTBN}" ] && ffmpeg_meets_fileflows_requirements "$(get_btbn_dir)" "${FFMPEG_BTBN}"; then
        btbn_ok=1
    fi

    if [ "${jellyfin_ok}" -eq 1 ]; then
        ln -sf "${FFMPEG_JELLYFIN}" "${FFMPEG_WRAPPER}"
        ln -sf "${FFPROBE_JELLYFIN}" "${FFPROBE_WRAPPER}"
        echo "✅ Default FFmpeg set to Jellyfin build (meets all requirements)."
        return
    fi

    if [ "${btbn_ok}" -eq 1 ]; then
        ln -sf "${FFMPEG_BTBN}" "${FFMPEG_WRAPPER}"
        ln -sf "${FFPROBE_BTBN}" "${FFPROBE_WRAPPER}"
        echo "✅ Default FFmpeg set to BtbN build (meets all requirements)."
        return
    fi

    local jellyfin_has_qsv=0
    local jellyfin_has_vaapi=0
    local jellyfin_has_opencl=0
    local jellyfin_has_libvmaf=0
    local jellyfin_has_libsvtav1=0
    if [ -x "${FFMPEG_JELLYFIN}" ]; then
        ffmpeg_has_filter "${JELLYFIN_DIR}" "${FFMPEG_JELLYFIN}" "vpp_qsv" && jellyfin_has_qsv=1
        ffmpeg_has_hwaccel "${JELLYFIN_DIR}" "${FFMPEG_JELLYFIN}" "vaapi" && jellyfin_has_vaapi=1
        ffmpeg_has_filter "${JELLYFIN_DIR}" "${FFMPEG_JELLYFIN}" "scale_opencl" && jellyfin_has_opencl=1
        ffmpeg_has_filter "${JELLYFIN_DIR}" "${FFMPEG_JELLYFIN}" "libvmaf" && jellyfin_has_libvmaf=1
        ffmpeg_has_encoder "${JELLYFIN_DIR}" "${FFMPEG_JELLYFIN}" "libsvtav1" && jellyfin_has_libsvtav1=1
    fi

    local btbn_has_qsv=0
    local btbn_has_vaapi=0
    local btbn_has_opencl=0
    local btbn_has_libvmaf=0
    local btbn_has_libsvtav1=0
    if [ -x "${FFMPEG_BTBN}" ]; then
        ffmpeg_has_filter "$(get_btbn_dir)" "${FFMPEG_BTBN}" "vpp_qsv" && btbn_has_qsv=1
        ffmpeg_has_hwaccel "$(get_btbn_dir)" "${FFMPEG_BTBN}" "vaapi" && btbn_has_vaapi=1
        ffmpeg_has_filter "$(get_btbn_dir)" "${FFMPEG_BTBN}" "scale_opencl" && btbn_has_opencl=1
        ffmpeg_has_filter "$(get_btbn_dir)" "${FFMPEG_BTBN}" "libvmaf" && btbn_has_libvmaf=1
        ffmpeg_has_encoder "$(get_btbn_dir)" "${FFMPEG_BTBN}" "libsvtav1" && btbn_has_libsvtav1=1
    fi

    cat >"${FFMPEG_WRAPPER}" <<'EOF'
#!/bin/bash
set -e

# Selector wrapper: choose the best available FFmpeg for the arguments.
# Override with: FFMPEG_FORCE=jellyfin|btbn

FFMPEG_FORCE="${FFMPEG_FORCE:-}"
FFMPEG_JELLYFIN="/usr/local/bin/ffmpeg.jellyfin"
FFMPEG_BTBN="/usr/local/bin/ffmpeg.btbn"
JELLYFIN_HAS_QSV=__JELLYFIN_HAS_QSV__
JELLYFIN_HAS_VAAPI=__JELLYFIN_HAS_VAAPI__
JELLYFIN_HAS_OPENCL=__JELLYFIN_HAS_OPENCL__
JELLYFIN_HAS_LIBVMAF=__JELLYFIN_HAS_LIBVMAF__
JELLYFIN_HAS_LIBSVTAV1=__JELLYFIN_HAS_LIBSVTAV1__
BTBN_HAS_QSV=__BTBN_HAS_QSV__
BTBN_HAS_VAAPI=__BTBN_HAS_VAAPI__
BTBN_HAS_OPENCL=__BTBN_HAS_OPENCL__
BTBN_HAS_LIBVMAF=__BTBN_HAS_LIBVMAF__
BTBN_HAS_LIBSVTAV1=__BTBN_HAS_LIBSVTAV1__

if [ "${FFMPEG_FORCE}" = "jellyfin" ] && [ -x "${FFMPEG_JELLYFIN}" ]; then
  exec "${FFMPEG_JELLYFIN}" "$@"
fi
if [ "${FFMPEG_FORCE}" = "btbn" ] && [ -x "${FFMPEG_BTBN}" ]; then
  exec "${FFMPEG_BTBN}" "$@"
fi

args=" $* "

# Prefer an FFmpeg that supports the requested accelerator.
if echo "${args}" | grep -qE '(_qsv|vpp_qsv|deinterlace_qsv|[[:space:]]qsv[[:space:]])'; then
  if [ "${JELLYFIN_HAS_QSV}" = "1" ] && [ -x "${FFMPEG_JELLYFIN}" ]; then exec "${FFMPEG_JELLYFIN}" "$@"; fi
  if [ "${BTBN_HAS_QSV}" = "1" ] && [ -x "${FFMPEG_BTBN}" ]; then exec "${FFMPEG_BTBN}" "$@"; fi
fi
if echo "${args}" | grep -qE '([[:space:]]vaapi[[:space:]]|_vaapi)'; then
  if [ "${JELLYFIN_HAS_VAAPI}" = "1" ] && [ -x "${FFMPEG_JELLYFIN}" ]; then exec "${FFMPEG_JELLYFIN}" "$@"; fi
  if [ "${BTBN_HAS_VAAPI}" = "1" ] && [ -x "${FFMPEG_BTBN}" ]; then exec "${FFMPEG_BTBN}" "$@"; fi
fi
if echo "${args}" | grep -qE '(_opencl|[[:space:]]opencl[[:space:]])'; then
  if [ "${JELLYFIN_HAS_OPENCL}" = "1" ] && [ -x "${FFMPEG_JELLYFIN}" ]; then exec "${FFMPEG_JELLYFIN}" "$@"; fi
  if [ "${BTBN_HAS_OPENCL}" = "1" ] && [ -x "${FFMPEG_BTBN}" ]; then exec "${FFMPEG_BTBN}" "$@"; fi
fi

# Prefer BtbN when we see quality-metric / AV1 testing encoders.
if echo "${args}" | grep -qE '(libvmaf)'; then
  if [ "${BTBN_HAS_LIBVMAF}" = "1" ] && [ -x "${FFMPEG_BTBN}" ]; then exec "${FFMPEG_BTBN}" "$@"; fi
  if [ "${JELLYFIN_HAS_LIBVMAF}" = "1" ] && [ -x "${FFMPEG_JELLYFIN}" ]; then exec "${FFMPEG_JELLYFIN}" "$@"; fi
fi
if echo "${args}" | grep -qE '(libsvtav1)'; then
  if [ "${BTBN_HAS_LIBSVTAV1}" = "1" ] && [ -x "${FFMPEG_BTBN}" ]; then exec "${FFMPEG_BTBN}" "$@"; fi
  if [ "${JELLYFIN_HAS_LIBSVTAV1}" = "1" ] && [ -x "${FFMPEG_JELLYFIN}" ]; then exec "${FFMPEG_JELLYFIN}" "$@"; fi
fi

# Default: Jellyfin first, then BtbN.
if [ -x "${FFMPEG_JELLYFIN}" ]; then exec "${FFMPEG_JELLYFIN}" "$@"; fi
if [ -x "${FFMPEG_BTBN}" ]; then exec "${FFMPEG_BTBN}" "$@"; fi

echo "ffmpeg wrapper: no ffmpeg found (expected ${FFMPEG_JELLYFIN} or ${FFMPEG_BTBN})" >&2
exit 127
EOF
    # Fill in capability placeholders
    sed -i \
        -e "s/__JELLYFIN_HAS_QSV__/${jellyfin_has_qsv}/g" \
        -e "s/__JELLYFIN_HAS_VAAPI__/${jellyfin_has_vaapi}/g" \
        -e "s/__JELLYFIN_HAS_OPENCL__/${jellyfin_has_opencl}/g" \
        -e "s/__JELLYFIN_HAS_LIBVMAF__/${jellyfin_has_libvmaf}/g" \
        -e "s/__JELLYFIN_HAS_LIBSVTAV1__/${jellyfin_has_libsvtav1}/g" \
        -e "s/__BTBN_HAS_QSV__/${btbn_has_qsv}/g" \
        -e "s/__BTBN_HAS_VAAPI__/${btbn_has_vaapi}/g" \
        -e "s/__BTBN_HAS_OPENCL__/${btbn_has_opencl}/g" \
        -e "s/__BTBN_HAS_LIBVMAF__/${btbn_has_libvmaf}/g" \
        -e "s/__BTBN_HAS_LIBSVTAV1__/${btbn_has_libsvtav1}/g" \
        "${FFMPEG_WRAPPER}"
    chmod +x "${FFMPEG_WRAPPER}"

    # For ffprobe we can safely prefer Jellyfin (hardware-aware); fall back to BtbN.
    cat >"${FFPROBE_WRAPPER}" <<'EOF'
#!/bin/bash
set -e
FFPROBE_JELLYFIN="/usr/local/bin/ffprobe.jellyfin"
FFPROBE_BTBN="/usr/local/bin/ffprobe.btbn"
if [ -x "${FFPROBE_JELLYFIN}" ]; then exec "${FFPROBE_JELLYFIN}" "$@"; fi
if [ -x "${FFPROBE_BTBN}" ]; then exec "${FFPROBE_BTBN}" "$@"; fi
echo "ffprobe wrapper: no ffprobe found (expected ${FFPROBE_JELLYFIN} or ${FFPROBE_BTBN})" >&2
exit 127
EOF
    chmod +x "${FFPROBE_WRAPPER}"

    echo "⚠️  Installed selector wrapper (no single FFmpeg build satisfied every requirement)."
}

# ---------------------- Main Actions ------------------------
function install_all {
    if [ -z "$common" ]; then
        echo "❌ ERROR: \$common is not set. Please export it before running the script."
        exit 1
    fi

    require_root
    ensure_prereqs

    echo "Installing to persistent path: $common"
    install_jellyfin_ffmpeg
    install_btbn_ffmpeg
    install_link_wrappers
    configure_default_ffmpeg
    echo "✅ All components installed."
}

function uninstall_all {
    require_root
    uninstall_jellyfin_ffmpeg
    uninstall_btbn_ffmpeg
    rm -f "${FFMPEG_WRAPPER}" "${FFPROBE_WRAPPER}" "${FFMPEG_BTBN}" "${FFPROBE_BTBN}"
    echo "🗑️ All components uninstalled."
}

# ---------------------- Entrypoint ------------------------
if [ "$1" == "--uninstall" ]; then
    uninstall_all
else
    install_all
fi

exit 0
