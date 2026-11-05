"""Private credential inventory used only by the administrator over SSH."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid
from devices import private

FORMATS = {'clash.yaml', 'shadowrocket.txt', 'rules.conf'}


class Registry:
    def __init__(self, root):
        self.root = private.directory(root)
        private.regular(self.root/'devices.db', create=True)
        with self.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS devices (
              id TEXT PRIMARY KEY, label TEXT NOT NULL, client TEXT NOT NULL,
              credential TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)''')
            db.execute('CREATE UNIQUE INDEX IF NOT EXISTS active_label ON devices(label) WHERE revoked=0')
        (self.root/'devices.db').chmod(0o600)

    @contextmanager
    def connect(self):
        private.regular(self.root/'devices.db')
        db = sqlite3.connect(self.root/'devices.db', timeout=5)
        db.row_factory = sqlite3.Row
        try:
            with db: yield db
        finally:
            db.close()

    @contextmanager
    def administration(self):
        # The lock covers SQLite and Xray together, including concurrent CLI processes.
        fd = os.open(self.root/'administration.lock', os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def find(self, label):
        with self.connect() as db:
            d = db.execute('SELECT * FROM devices WHERE label=? AND revoked=0', (label,)).fetchone()
            return dict(d) if d else None

    def create(self, label, client):
        if client not in ('clash', 'shadowrocket'): raise ValueError('Invalid client')
        if not isinstance(label,str) or not label.strip() or len(label)>80 or any(ord(c)<32 for c in label):
            raise ValueError('Invalid device label')
        d = {'id': secrets.token_hex(12), 'label': label, 'client': client,
             'credential': str(uuid.uuid4()), 'revoked': 0, 'created': int(time.time())}
        with self.connect() as db:
            db.execute('INSERT INTO devices(id,label,client,credential,revoked,created) VALUES(:id,:label,:client,:credential,:revoked,:created)', d)
        return d

    def devices(self, include_revoked=False):
        with self.connect() as db:
            return [dict(d) for d in db.execute('SELECT * FROM devices'+('' if include_revoked else ' WHERE revoked=0'))]

    def revoke(self, device):
        with self.connect() as db:
            db.execute('UPDATE devices SET revoked=1 WHERE id=?', (device,))

    def write_profiles(self, device, profiles):
        if not re.fullmatch(r'[a-f0-9]{24}', device): raise ValueError('Invalid device ID')
        private.directory(self.root/'profiles')
        directory = private.directory(self.root/'profiles'/device)
        for name,payload in profiles.items():
            if name not in FORMATS: raise ValueError('Invalid profile type')
            private.write(directory/name, payload)
