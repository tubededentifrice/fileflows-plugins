#!/bin/bash

set -e
set -o pipefail

BASE_DIR="/opt/fileflows-langid"
VENV_DIR="${BASE_DIR}/venv"
PYTHON=""
PIP=""

resolve_self_path() {
    local p="$0"
    if command -v readlink >/dev/null 2>&1; then
        p="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    fi
    echo "$p"
}

ensure_uninstall_shim() {
    # FileFlows sometimes runs uninstall via: sudo "<script> --uninstall"
    # which causes sudo to treat the whole string as the command name.
    # Work around by creating a file literally named "<script> --uninstall"
    # that calls the real script with a proper --uninstall argument.
    local self
    self="$(resolve_self_path)"
    local base="${self% --uninstall}"
    local shim="${base} --uninstall"

    if [ -f "${shim}" ]; then
        chmod +x "${shim}" || true
        return 0
    fi

    cat >"${shim}" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
base="${0% --uninstall}"
exec /bin/bash "${base}" --uninstall
SH
    chmod +x "${shim}"
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo "ERROR: This script must be run as root inside the container." >&2
        exit 1
    fi
}

uninstall_all() {
    local self
    self="$(resolve_self_path)"
    local base="${self% --uninstall}"
    local shim="${base} --uninstall"

    rm -f /usr/local/bin/fflangid-sb /usr/local/bin/fflangid-whisper /usr/local/bin/fflangid-whispercpp || true

    for p in /usr/bin/fflangid-sb /usr/bin/fflangid-whisper /usr/bin/fflangid-whispercpp; do
        if [ -L "${p}" ]; then
            rm -f "${p}" || true
        fi
    done

    rm -f "${shim}" || true

    if [ "${FFLANGID_REMOVE_DATA:-0}" = "1" ]; then
        rm -rf "${BASE_DIR}" || true
    fi

    echo "OK: Uninstalled fflangid wrappers."
    if [ "${FFLANGID_REMOVE_DATA:-0}" = "1" ]; then
        echo "OK: Removed ${BASE_DIR} (FFLANGID_REMOVE_DATA=1)."
    else
        echo "NOTE: Kept ${BASE_DIR}. Set FFLANGID_REMOVE_DATA=1 to remove cached models/venv."
    fi
}

ensure_apt_prereqs() {
    if ! command -v apt-get >/dev/null 2>&1; then
        echo "ERROR: apt-get not found; this DockerMod expects Ubuntu/Debian." >&2
        exit 1
    fi

    apt-get -qq update
    apt-get install --no-install-recommends --no-install-suggests -yqq \
        ca-certificates curl git jq \
        python3 python3-venv python3-pip python3-setuptools python3-wheel \
        build-essential cmake pkg-config \
        libsndfile1 \
        mkvtoolnix
}

ensure_python_venv() {
    mkdir -p "${BASE_DIR}"

    if [ -x "${VENV_DIR}/bin/python" ]; then
        python3 -m venv --upgrade "${VENV_DIR}"
    else
        python3 -m venv "${VENV_DIR}"
    fi

    PYTHON="${VENV_DIR}/bin/python"
    PIP="${VENV_DIR}/bin/pip"

    # Avoid Debian/Ubuntu PEP 668 "externally-managed-environment" by never using system pip.
    "${PIP}" install --no-cache-dir -q -U pip setuptools wheel
}

install_torch_stack() {
    # Use PyTorch CPU wheels inside the venv to avoid distro torchaudio/torch mismatches.
    "${PIP}" install --no-cache-dir -q torch torchaudio --index-url https://download.pytorch.org/whl/cpu

    # SpeechBrain currently expects older huggingface_hub APIs (use_auth_token). Newer huggingface_hub
    # removed that keyword which breaks runtime model fetching/caching.
    # Pin to a known-compatible version to keep fflangid-sb working offline once prewarmed.
    "${PIP}" install --no-cache-dir -q "huggingface_hub==0.19.4"

    "${PIP}" install --no-cache-dir -q speechbrain soundfile numpy scipy requests

    # Re-assert the pin in case dependency resolution upgraded it.
    "${PIP}" install --no-cache-dir -q "huggingface_hub==0.19.4"
}

install_whisper_cpp() {
    local src_dir="${BASE_DIR}/whisper.cpp"
    local model_dir="${BASE_DIR}/whisper-models"
    local bin_dst="/usr/local/bin/fflangid-whispercpp"

    mkdir -p "${BASE_DIR}" "${model_dir}"

    if [ ! -d "${src_dir}/.git" ]; then
        git clone --depth 1 https://github.com/ggerganov/whisper.cpp "${src_dir}"
    else
        git -C "${src_dir}" pull --ff-only
    fi

    local jobs
    jobs="$(nproc 2>/dev/null || echo 1)"

    set +e
    make -C "${src_dir}" -j"${jobs}" whisper-cli
    local make_rc=$?
    if [ "${make_rc}" -ne 0 ]; then
        make -C "${src_dir}" -j"${jobs}" main
        make_rc=$?
    fi
    if [ "${make_rc}" -ne 0 ]; then
        make -C "${src_dir}" -j"${jobs}"
        make_rc=$?
    fi
    set -e

    if [ "${make_rc}" -ne 0 ]; then
        echo "WARN: Failed to build whisper.cpp. Whisper fallback will be unavailable." >&2
        return 0
    fi

    local built=""
    for candidate in \
        "${src_dir}/whisper-cli" \
        "${src_dir}/main" \
        "${src_dir}/bin/main" \
        "${src_dir}/bin/whisper-cli" \
        "${src_dir}/build/bin/main" \
        "${src_dir}/build/bin/whisper-cli"; do
        if [ -x "${candidate}" ]; then
            built="${candidate}"
            break
        fi
    done

    if [ -z "${built}" ] && command -v find >/dev/null 2>&1; then
        # Use quoted parens to avoid shell parsing issues in environments that don't preserve backslashes.
        built="$(find "${src_dir}" -maxdepth 6 -type f -perm -111 '(' -name whisper-cli -o -name main ')' 2>/dev/null | head -n 1 || true)"
    fi

    if [ -z "${built}" ]; then
        echo "WARN: whisper.cpp build succeeded but no CLI binary was found (expected whisper-cli/main). Whisper fallback will be unavailable." >&2
        return 0
    fi

    # If multiple candidates exist, prefer a "real" binary (largest file tends to be the actual CLI).
    if command -v stat >/dev/null 2>&1 && command -v sort >/dev/null 2>&1 && command -v head >/dev/null 2>&1; then
        local best_line best
        best_line="$(find "${src_dir}" -maxdepth 8 -type f -perm -111 '(' -name whisper-cli -o -name main ')' -exec stat -c '%s %n' {} + 2>/dev/null | sort -nr | head -n 1 || true)"
        best="${best_line#* }"
        if [ -n "${best}" ] && [ -x "${best}" ]; then
            built="${best}"
        fi
    fi

    install -m 0755 "${built}" "${bin_dst}"

    if command -v stat >/dev/null 2>&1; then
        local sz
        sz="$(stat -c%s "${bin_dst}" 2>/dev/null || echo 0)"
        if [ "${sz}" -gt 0 ] && [ "${sz}" -lt 500000 ]; then
            echo "WARN: Installed whisper binary is unexpectedly small (${sz} bytes): ${bin_dst}" >&2
        fi
    fi

    # Model: ggml-tiny.bin (fast, CPU friendly). Stored outside the repo so it persists across updates.
    if [ ! -f "${model_dir}/ggml-tiny.bin" ]; then
        if ! curl -L --retry 3 --fail -o "${model_dir}/ggml-tiny.bin" \
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"; then
            echo "WARN: Failed to download whisper.cpp model (ggml-tiny.bin). Whisper fallback will not work until the model is present." >&2
            echo "      Place the model at: ${model_dir}/ggml-tiny.bin" >&2
        fi
    fi
}

install_wrappers() {
    local model_dir="${BASE_DIR}/whisper-models"
    local sb_cache_dir="${BASE_DIR}/speechbrain-cache"
    local sb_py="${VENV_DIR}/bin/python"

    mkdir -p "${sb_cache_dir}"
    # FileFlows often runs nodes as a non-root user; ensure the cache is writable at runtime.
    chmod 0777 "${sb_cache_dir}" 2>/dev/null || true

    {
        echo "#!${sb_py}"
        cat <<'PY'
import json
import os
import sys

def _ensure_torchaudio_compat():
    try:
        import torchaudio  # noqa: F401
    except Exception:
        return

    # SpeechBrain (and some versions of its deps) expect these helpers to exist.
    if not hasattr(torchaudio, "list_audio_backends"):
        torchaudio.list_audio_backends = lambda: []  # type: ignore[attr-defined]
    if not hasattr(torchaudio, "set_audio_backend"):
        torchaudio.set_audio_backend = lambda backend: None  # type: ignore[attr-defined]

def main():
    if len(sys.argv) in (2, 3) and sys.argv[1] in ("--version", "-V"):
        try:
            _ensure_torchaudio_compat()
            import requests  # noqa: F401
            import soundfile  # noqa: F401
            import torch  # noqa: F401
            from speechbrain.inference.classifiers import EncoderClassifier  # noqa: F401
        except Exception as e:
            print("fflangid-sb unavailable", file=sys.stderr)
            print(str(e), file=sys.stderr)
            return 3
        print("fflangid-sb 1")
        return 0

    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing wav path"}))
        return 2

    wav_path = sys.argv[1]
    cache_dir = os.environ.get("FFLANGID_SPEECHBRAIN_CACHE", "/opt/fileflows-langid/speechbrain-cache")
    os.makedirs(cache_dir, exist_ok=True)

    # Force all HF/torch caches to a writable location. Some deps still expanduser("~")
    # and try to create /home/<user> (which may not be writable in containers).
    try:
        os.environ.setdefault("HOME", cache_dir)
        os.environ.setdefault("XDG_CACHE_HOME", cache_dir)
        os.environ.setdefault("HF_HOME", cache_dir)
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", os.path.join(cache_dir, "hub"))
        os.environ.setdefault("TRANSFORMERS_CACHE", os.path.join(cache_dir, "transformers"))
        os.environ.setdefault("TORCH_HOME", os.path.join(cache_dir, "torch"))
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        for d in (
            cache_dir,
            os.environ["HUGGINGFACE_HUB_CACHE"],
            os.environ["TRANSFORMERS_CACHE"],
            os.environ["TORCH_HOME"],
        ):
            os.makedirs(d, exist_ok=True)
    except Exception:
        pass

    try:
        _ensure_torchaudio_compat()
        import numpy as np
        import soundfile as sf
        import torch
        from speechbrain.inference.classifiers import EncoderClassifier
    except Exception as e:
        print(json.dumps({"error": "speechbrain import failed", "detail": str(e)}))
        return 3

    try:
        classifier = EncoderClassifier.from_hparams(
            source="speechbrain/lang-id-voxlingua107-ecapa",
            savedir=cache_dir,
            run_opts={"device": "cpu"},
        )

        # Avoid torchaudio backend issues by loading with soundfile directly.
        sig, sr = sf.read(wav_path, dtype="float32", always_2d=False)
        if hasattr(sig, "ndim") and sig.ndim > 1:
            sig = np.mean(sig, axis=1)
        wavs = torch.from_numpy(np.asarray(sig, dtype="float32")).unsqueeze(0)
        wav_lens = torch.tensor([1.0], dtype=torch.float32)
        try:
            out = classifier.classify_batch(wavs, wav_lens)
        except TypeError:
            out = classifier.classify_batch(wavs)

        # speechbrain returns tuples; normalize across versions.
        lang = None
        confidence = None
        # Common: (probabilities, score, index, text_lab)
        if isinstance(out, (list, tuple)) and len(out) >= 4:
            try:
                text_lab = out[3]
                if isinstance(text_lab, (list, tuple)) and len(text_lab) > 0:
                    lang = str(text_lab[0])
                else:
                    lang = str(text_lab)
            except Exception:
                pass

            # Prefer a true probability from the returned probability tensor when available.
            try:
                probs = out[0]
                idx = out[2]
                if hasattr(idx, "item"):
                    idx = int(idx.item())
                elif isinstance(idx, (list, tuple)) and len(idx) > 0:
                    idx0 = idx[0]
                    idx = int(idx0.item()) if hasattr(idx0, "item") else int(idx0)
                elif isinstance(idx, str):
                    idx = int(idx)

                if hasattr(probs, "detach"):
                    pt = probs.detach().cpu()
                    if hasattr(pt, "ndim") and pt.ndim >= 2:
                        confidence = float(pt[0][idx])
                    else:
                        confidence = float(pt[idx])
            except Exception:
                pass

            # Fallback: some versions return a scalar score (sometimes log-prob); keep as-is if positive.
            if confidence is None:
                try:
                    score = out[1]
                    if isinstance(score, (list, tuple)) and len(score) > 0:
                        confidence = float(score[0])
                    else:
                        confidence = float(score)
                except Exception:
                    pass

        # Fallback: sometimes classify_file returns a dict-like structure
        if lang is None and isinstance(out, dict):
            lang = out.get("lang") or out.get("language") or out.get("label")
            confidence = out.get("confidence")

        # Normalize label strings like "en: English" -> "en"
        if isinstance(lang, str):
            lang = lang.strip()
            if ":" in lang:
                lang = lang.split(":", 1)[0].strip()

        # Normalize confidence into [0,1] when possible.
        if confidence is not None:
            try:
                conf = float(confidence)
                if conf > 1.0:
                    # Sometimes returned as percent.
                    if conf <= 100.0:
                        conf = conf / 100.0
                elif conf < 0.0:
                    # Some SpeechBrain versions expose log-prob; convert best-effort.
                    import math
                    conf = math.exp(conf)
                if conf < 0.0:
                    conf = 0.0
                if conf > 1.0:
                    conf = 1.0
                confidence = conf
            except Exception:
                pass

        payload = {
            "lang": lang,
            "confidence": confidence,
            "source": "speechbrain/lang-id-voxlingua107-ecapa",
        }
        print(json.dumps(payload))
        return 0
    except Exception as e:
        print(json.dumps({"error": "classification failed", "detail": str(e)}))
        return 4

if __name__ == "__main__":
    sys.exit(main())
PY
    } >/usr/local/bin/fflangid-sb
    chmod +x /usr/local/bin/fflangid-sb

cat >/usr/local/bin/fflangid-whisper <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" || "${1:-}" == "-V" ]]; then
  bin="${FFLANGID_WHISPER_BIN:-/usr/local/bin/fflangid-whispercpp}"
  model="${FFLANGID_WHISPER_MODEL:-/opt/fileflows-langid/whisper-models/ggml-tiny.bin}"
  if [[ ! -x "${bin}" ]]; then
    echo "fflangid-whisper unavailable: whisper binary not found (set FFLANGID_WHISPER_BIN)" >&2
    exit 3
  fi
  if [[ ! -f "${model}" ]]; then
    echo "fflangid-whisper unavailable: whisper model not found (set FFLANGID_WHISPER_MODEL)" >&2
    exit 4
  fi
  echo "fflangid-whisper 1"
  exit 0
fi

wav="${1:-}"
if [[ -z "${wav}" ]]; then
  echo '{"error":"missing wav path"}'
  exit 2
fi

bin="${FFLANGID_WHISPER_BIN:-/usr/local/bin/fflangid-whispercpp}"
model="${FFLANGID_WHISPER_MODEL:-/opt/fileflows-langid/whisper-models/ggml-tiny.bin}"

if [[ ! -x "${bin}" ]]; then
  echo '{"error":"whisper binary not found","detail":"set FFLANGID_WHISPER_BIN"}'
  exit 3
fi
if [[ ! -f "${model}" ]]; then
  echo '{"error":"whisper model not found","detail":"set FFLANGID_WHISPER_MODEL"}'
  exit 4
fi

tmpdir="$(mktemp -d)"
tmp="${tmpdir}/out.txt"
trap 'rm -rf "${tmpdir}"' EXIT

extract_lang_from_text() {
  local file="$1"
  local lang=""

  # whisper.cpp output format varies by version; handle common patterns.
  lang="$(grep -Eio 'auto[- ]detected language[^a-z]*[a-z]{2,3}' "${file}" 2>/dev/null | tail -n1 | grep -Eo '[a-z]{2,3}$' || true)"
  if [[ -z "${lang}" ]]; then
    lang="$(grep -Eio 'detected language[^a-z]*[a-z]{2,3}' "${file}" 2>/dev/null | tail -n1 | grep -Eo '[a-z]{2,3}$' || true)"
  fi
  if [[ -z "${lang}" ]]; then
    lang="$(grep -Eio 'language[^a-z]*[a-z]{2,3}' "${file}" 2>/dev/null | tail -n1 | grep -Eo '[a-z]{2,3}$' || true)"
  fi
  if [[ -z "${lang}" ]]; then
    lang="$(grep -Eio 'lang[^a-z]*[a-z]{2,3}' "${file}" 2>/dev/null | tail -n1 | grep -Eo '[a-z]{2,3}$' || true)"
  fi

  if [[ -n "${lang}" ]]; then
    printf "%s" "${lang}"
  fi
}

extract_lang_from_json() {
  local file="$1"
  local lang=""

  if command -v jq >/dev/null 2>&1; then
    lang="$(jq -r '.language // .result.language // .metadata.language // empty' "${file}" 2>/dev/null | head -n1 || true)"
  fi
  if [[ -z "${lang}" ]]; then
    lang="$(grep -Eo '"language"[[:space:]]*:[[:space:]]*"[a-z]{2,3}"' "${file}" 2>/dev/null | head -n1 | grep -Eo '[a-z]{2,3}' || true)"
  fi

  if [[ -n "${lang}" ]]; then
    printf "%s" "${lang}"
  fi
}

rc=1
set +e

# Prefer language-only detection if supported (avoids full transcription and is faster).
"${bin}" -m "${model}" -f "${wav}" --detect-language >"${tmp}" 2>&1
rc=$?
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" -m "${model}" -f "${wav}" -dl >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -eq 0 ]]; then
  lang="$(extract_lang_from_text "${tmp}" || true)"
  if [[ -n "${lang}" ]]; then
    set -e
    printf '{"lang":"%s","source":"whisper.cpp"}\n' "${lang}"
    exit 0
  fi
fi

# Try JSON output modes (some versions don’t print detected language in console output).
json_base="${tmpdir}/whisper"
json_file=""
"${bin}" -m "${model}" -f "${wav}" -l auto -nt -np -oj -of "${json_base}" >"${tmp}" 2>&1
rc=$?
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" -m "${model}" -f "${wav}" -l auto -nt -np --output-json --output-file "${json_base}" >"${tmp}" 2>&1
  rc=$?
fi

if [[ "${rc}" -eq 0 ]]; then
  for candidate in "${json_base}.json" "${json_base}.jsonl" "${json_base}.out.json" "${json_base}.output.json"; do
    if [[ -f "${candidate}" ]]; then
      json_file="${candidate}"
      break
    fi
  done
  if [[ -z "${json_file}" ]]; then
    json_file="$(ls -1 "${tmpdir}"/*.json 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -n "${json_file}" ]]; then
    lang="$(extract_lang_from_json "${json_file}" || true)"
    if [[ -n "${lang}" ]]; then
      set -e
      printf '{"lang":"%s","source":"whisper.cpp"}\n' "${lang}"
      exit 0
    fi
  fi
fi

# Fallback: run transcription and scrape the console output.
"${bin}" -m "${model}" -f "${wav}" -l auto -nt -np >"${tmp}" 2>&1
rc=$?
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" -m "${model}" -f "${wav}" -l auto -nt >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" -m "${model}" -f "${wav}" -l auto >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" -m "${model}" -f "${wav}" >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" -m "${model}" -f "${wav}" -nt >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" --model "${model}" --file "${wav}" --language auto --no-timestamps --no-print-progress >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" --model "${model}" --file "${wav}" --language auto --no-timestamps >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" --model "${model}" --file "${wav}" --language auto >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" --model "${model}" --file "${wav}" --no-timestamps --no-print-progress >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" --model "${model}" --file "${wav}" --no-timestamps >"${tmp}" 2>&1
  rc=$?
fi
if [[ "${rc}" -ne 0 ]]; then
  "${bin}" --model "${model}" --file "${wav}" >"${tmp}" 2>&1
  rc=$?
fi
set -e

if [[ "${rc}" -ne 0 ]]; then
  tail_out="$(tail -n 30 "${tmp}" 2>/dev/null | tr -d '\r' | sed -e 's/\\/\\\\/g' -e 's/\"/\\\"/g' | tr '\n' ' ' | sed -e 's/  */ /g')"
  echo "{\"error\":\"whisper failed\",\"exitCode\":${rc},\"detail\":\"${tail_out}\"}"
  exit 5
fi

lang="$(extract_lang_from_text "${tmp}" || true)"

if [[ -z "${lang}" ]]; then
  tail_out="$(tail -n 30 "${tmp}" 2>/dev/null | tr -d '\r' | sed -e 's/\\/\\\\/g' -e 's/\"/\\\"/g' | tr '\n' ' ' | sed -e 's/  */ /g')"
  echo "{\"error\":\"language not found in output\",\"detail\":\"${tail_out}\"}"
  exit 6
fi

printf '{"lang":"%s","source":"whisper.cpp"}\n' "${lang}"
SH
    chmod +x /usr/local/bin/fflangid-whisper

    # Ensure availability even if /usr/local/bin isn't on PATH for the runtime user.
    if [ -x /usr/local/bin/fflangid-sb ]; then ln -sf /usr/local/bin/fflangid-sb /usr/bin/fflangid-sb; fi
    if [ -x /usr/local/bin/fflangid-whisper ]; then ln -sf /usr/local/bin/fflangid-whisper /usr/bin/fflangid-whisper; fi
    if [ -x /usr/local/bin/fflangid-whispercpp ]; then ln -sf /usr/local/bin/fflangid-whispercpp /usr/bin/fflangid-whispercpp; fi
}

prewarm_speechbrain() {
    # Best-effort: download model now so runtime doesn't need network.
    "${PYTHON}" - <<'PY' || true
import os
try:
    from speechbrain.inference.classifiers import EncoderClassifier
except Exception:
    raise SystemExit(0)

cache_dir = os.environ.get("FFLANGID_SPEECHBRAIN_CACHE", "/opt/fileflows-langid/speechbrain-cache")
os.makedirs(cache_dir, exist_ok=True)
EncoderClassifier.from_hparams(
    source="speechbrain/lang-id-voxlingua107-ecapa",
    savedir=cache_dir,
)
print("SpeechBrain model cached in", cache_dir)
PY
}

main() {
    if [ "${1:-}" = "--uninstall" ] || [[ "$(basename "$0")" == *" --uninstall" ]]; then
        require_root
        uninstall_all
        return 0
    fi

    require_root
    ensure_uninstall_shim
    ensure_apt_prereqs
    ensure_python_venv
    install_torch_stack
    install_wrappers
    prewarm_speechbrain
    install_whisper_cpp

    echo "OK: Installed mkvpropedit, SpeechBrain LID (fflangid-sb), and whisper.cpp fallback (fflangid-whisper)."
    echo "Models in /opt/fileflows-langid (consider mounting this as a persistent volume)."
    if [ ! -f "${BASE_DIR}/whisper-models/ggml-tiny.bin" ]; then
        echo "NOTE: whisper.cpp model is missing: ${BASE_DIR}/whisper-models/ggml-tiny.bin"
    fi
}

main "$@"
