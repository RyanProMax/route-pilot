"""Fail closed on redirected or foreign-owned private state paths."""
import os
from pathlib import Path
import secrets
import stat


def directory(path):
    path = Path(path)
    if path.is_symlink(): raise ValueError('Private directory must not be a symlink')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise ValueError('Private directory must belong to the current administrator')
    path.chmod(0o700)
    return path


def regular(path, create=False):
    path = Path(path)
    if create and not path.exists() and not path.is_symlink():
        fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        os.close(fd)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
        raise ValueError('Private file must be an administrator-owned regular file with one link')
    # Read-only systemd mounts may contain an already-private configuration.
    # Avoid a redundant chmod; never broaden writable paths just to read it.
    if stat.S_IMODE(info.st_mode) != 0o600:
        path.chmod(0o600)
    return path


def write(path, content):
    path = Path(path)
    directory(path.parent)
    if path.exists() or path.is_symlink(): regular(path)
    temporary = path.with_name('.'+path.name+'.'+secrets.token_hex(8))
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(content.encode() if isinstance(content,str) else content)
            f.flush(); os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
