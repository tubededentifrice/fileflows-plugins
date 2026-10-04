/**
 * @name SafeFileReplace
 * @uid 70b17d2b-3de4-4aa4-a38b-99b01d266762
 * @description Checked file replacement with a recovery copy outside the runner directory.
 * @author Vincent Courcelle
 * @revision 1
 * @minimumVersion 25.0.0.0
 */
function replacementPython() {
    return String.raw`
import errno
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid


def fingerprint(path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode):
        raise ValueError("Expected a regular file: " + str(path))
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def checked_copy(source, target):
    h = hashlib.sha256()
    with source.open("rb") as src, target.open("xb") as dst:
        for block in iter(lambda: src.read(4 * 1024 * 1024), b""):
            dst.write(block)
            h.update(block)
        dst.flush()
        os.fsync(dst.fileno())
    if digest(target) != h.hexdigest():
        raise OSError(errno.EIO, "Copy checksum mismatch", str(target))
    return h.hexdigest()


def save_manifest(directory, data):
    pending = directory / "manifest.tmp"
    with pending.open("w") as stream:
        json.dump(data, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(pending, directory / "manifest.json")
    sync_directory(directory)


def replace_file(source, original, recovery_root, runner, preserve_dates=True):
    source, original = Path(source).absolute(), Path(original).absolute()
    runner, recovery_root = Path(runner).resolve(), Path(recovery_root).resolve()
    if recovery_root == runner or runner in recovery_root.parents:
        raise ValueError("Recovery directory must be outside the runner directory")
    if source == original:
        raise ValueError("Replacement needs a separate encoded file")
    source_before = fingerprint(source)
    if source_before[2] <= 0:
        raise ValueError("Encoded file is empty")
    recovery_root.mkdir(parents=True, exist_ok=True)
    directory = recovery_root / str(uuid.uuid4())
    directory.mkdir(mode=0o700)
    sync_directory(recovery_root)
    encoded = directory / ("encoded" + source.suffix)
    manifest = {"source": str(source), "original": str(original),
                "encoded": str(encoded), "bytes": source_before[2], "state": "retaining"}
    save_manifest(directory, manifest)
    try:
        # Hard links stay inside the temporary share, never between NAS shares.
        os.link(source, encoded)
        with encoded.open("rb") as stream:
            os.fsync(stream.fileno())
    except OSError:
        if encoded.exists():
            raise
        checked_copy(source, encoded)
    sync_directory(directory)
    manifest["state"] = "retained"
    save_manifest(directory, manifest)
    encoded_before = fingerprint(encoded)
    print("Replacement recovery file: " + str(encoded), flush=True)

    stage = None
    backup = None
    committed = False
    try:
        original_before = fingerprint(original)
        original_stat = original.stat()
        destination = original if original.suffix.lower() == source.suffix.lower() else original.with_suffix(source.suffix)
        manifest["destination"] = str(destination)
        if destination != original and os.path.lexists(destination):
            raise FileExistsError("Output path already exists: " + str(destination))
        stage = original.parent / (".ffreplace-" + directory.name + ".tmp")
        manifest["stage"] = str(stage)
        save_manifest(directory, manifest)
        checksum = checked_copy(encoded, stage)
        if fingerprint(source) != source_before or fingerprint(encoded) != encoded_before:
            raise OSError(errno.EBUSY, "Encoded source changed during replacement")
        if fingerprint(original) != original_before:
            raise OSError(errno.EBUSY, "Original changed during replacement")
        os.chmod(stage, stat.S_IMODE(original_stat.st_mode))
        os.chown(stage, original_stat.st_uid, original_stat.st_gid)
        if preserve_dates:
            os.utime(stage, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        with stage.open("rb") as stream:
            os.fsync(stream.fileno())
        backup = original.parent / (".fforiginal-" + directory.name + ".bak")
        os.link(original, backup)
        sync_directory(original.parent)
        manifest.update(state="ready", original_backup=str(backup), sha256=checksum)
        save_manifest(directory, manifest)
        if fingerprint(original) != original_before:
            raise OSError(errno.EBUSY, "Original changed before replacement")
        if destination == original:
            os.replace(stage, destination)
        else:
            # Publish without overwriting another file that appeared during the copy.
            os.link(stage, destination)
        committed = True
        sync_directory(original.parent)
        if destination != original:
            if fingerprint(original) != original_before:
                raise OSError(errno.EBUSY, "Original changed before removal")
            original.unlink()
            sync_directory(original.parent)
        manifest["state"] = "committed"
        save_manifest(directory, manifest)
    except Exception as error:
        manifest.update(state="failed_after_commit" if committed else "failed", error=str(error))
        try:
            save_manifest(directory, manifest)
        except OSError:
            pass
        print("Replacement failed; encoded file retained: " + str(encoded), flush=True)
        if backup is not None and backup.exists():
            print("Original recovery file: " + str(backup), flush=True)
        raise
    finally:
        if stage is not None and stage.exists():
            try:
                stage.unlink()
            except OSError:
                pass

    # The verified replacement is durable before recovery copies are removed.
    try:
        backup.unlink()
        sync_directory(original.parent)
        encoded.unlink()
        (directory / "manifest.json").unlink()
        directory.rmdir()
        sync_directory(recovery_root)
    except OSError as error:
        print("Replacement completed; recovery cleanup failed: " + str(error), flush=True)
    return {"destination": str(destination), "bytes": source_before[2], "sha256": checksum}


if __name__ == "__main__":
    try:
        result = replace_file(*sys.argv[1:5], preserve_dates=sys.argv[5] == "true")
        print("REPLACED " + json.dumps(result), flush=True)
    except Exception as error:
        print("Replacement error: " + str(error), file=sys.stderr, flush=True)
        sys.exit(2)
`;
}

export class SafeFileReplace {
    python() {
        return replacementPython();
    }
}
