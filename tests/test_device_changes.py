import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from devices.provision import apply_xray, provision, revoke
from devices.registry import Registry


class DeviceChangesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)/'config.json'
        self.original = {'inbounds': [{'protocol': 'vless', 'streamSettings': {'security': 'reality'},
                                     'settings': {'clients': [{'id': 'legacy', 'email': 'rp.unrelated@example.invalid'}]}}]}
        self.path.write_text(json.dumps(self.original))
        self.path.chmod(0o640)
        self.settings = {'xray_config': str(self.path), 'xray_service': 'xray'}
        self.registry = Registry(Path(self.tmp.name)/'state')

    def apply(self, value):
        apply_xray(value, self.path, 'xray', backup_dir=Path(self.tmp.name)/'backups')

    def test_invalid_candidate_never_replaces_current_config(self):
        def reject(argv, **kw):
            candidate = Path(argv[-1])
            self.assertEqual(candidate.suffix, '.json')
            self.assertEqual(candidate.stat().st_mode & 0o777, 0o640)
            self.assertEqual(candidate.stat().st_gid, self.path.stat().st_gid)
            return subprocess.CompletedProcess(argv, 1)
        with patch('devices.provision.subprocess.run', side_effect=reject):
            with self.assertRaises(RuntimeError): self.apply({'new': True})
        self.assertEqual(json.loads(self.path.read_text()), self.original)
        self.assertEqual(list(self.path.parent.glob('.routepilot-*.json')), [])

    def test_restart_failure_restores_content_and_permissions(self):
        before = self.path.stat()
        calls = []
        def run(argv, **kw):
            calls.append(argv)
            if len(calls) == 2:
                self.assertEqual(json.loads(self.path.read_text()), {'new': True})
                raise subprocess.CalledProcessError(1, argv)
            return subprocess.CompletedProcess(argv, 0)
        with patch('devices.provision.subprocess.run', side_effect=run):
            with self.assertRaises(RuntimeError): self.apply({'new': True})
        self.assertEqual(json.loads(self.path.read_text()), self.original)
        after = self.path.stat()
        self.assertEqual((after.st_mode & 0o777, after.st_uid, after.st_gid),
                         (0o640, before.st_uid, before.st_gid))
        backup = next((self.path.parent/'backups').glob('*.json'))
        self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(calls), 3)

    def test_concurrent_registration_keeps_both_credentials_and_revoke_removes_one(self):
        def apply(candidate, path, service):
            Path(path).write_text(json.dumps(candidate))
        def add(n):
            return provision(self.registry, self.settings, f'Mac{n}', 'clash')
        with patch('devices.provision.build_profiles', return_value={'clash.yaml': '{}'}), \
             patch('devices.provision.apply_xray', side_effect=apply):
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                devices = list(pool.map(add, [1, 2]))
            clients = json.loads(self.path.read_text())['inbounds'][0]['settings']['clients']
            self.assertEqual({u['id'] for u in clients}, {'legacy', *(d['credential'] for d in devices)})
            revoke(self.registry, self.settings, devices[0]['id'])
        remaining = json.loads(self.path.read_text())['inbounds'][0]['settings']['clients']
        self.assertEqual({u['id'] for u in remaining}, {'legacy', devices[1]['credential']})
        self.assertEqual([d['id'] for d in self.registry.devices()], [devices[1]['id']])

    def test_reissue_reuses_identity_and_failed_update_does_not_revoke_it(self):
        with patch('devices.provision.build_profiles', return_value={'clash.yaml': '{}'}), \
             patch('devices.provision.apply_xray'):
            first = provision(self.registry, self.settings, 'Mac', 'clash')
            repeated = provision(self.registry, self.settings, 'Mac', 'clash')
        self.assertEqual(first, repeated)
        self.assertEqual(len(self.registry.devices()), 1)
        with patch('devices.provision.build_profiles', side_effect=RuntimeError('Invalid renderer')):
            with self.assertRaises(RuntimeError): provision(self.registry, self.settings, 'Mac', 'clash')
        self.assertEqual(self.registry.find('Mac')['credential'], first['credential'])
        with patch('devices.provision.build_profiles', return_value={'shadowrocket.txt': 'profile'}), patch('devices.provision.apply_xray'):
            other_format = provision(self.registry, self.settings, 'Mac', 'shadowrocket')
        self.assertEqual(other_format['credential'], first['credential'])

    def test_private_files_and_explicit_replacement(self):
        with patch('devices.provision.build_profiles', return_value={'clash.yaml': 'private-profile'}), \
             patch('devices.provision.apply_xray'):
            old = provision(self.registry, self.settings, 'Mac', 'clash')
            revoke(self.registry, self.settings, old['id'])
            new = provision(self.registry, self.settings, 'Mac', 'clash')
        self.assertNotEqual(old['credential'], new['credential'])
        self.assertNotEqual(old['id'], new['id'])
        for path in (self.registry.root/'devices.db', self.registry.root/'profiles'/new['id']/'clash.yaml'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.registry.root.stat().st_mode & 0o777, 0o700)


if __name__ == '__main__':
    unittest.main()
