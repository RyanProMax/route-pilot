import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from devices.registry import Registry
from devices.control import apply,describe

class ControlTests(unittest.TestCase):
    def test_publish_rotate_rename_and_retry_keep_node_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);registry=Registry(root/'devices');device=registry.create('Laptop','clash');source=root/'config.json';source.write_text('{}')
            settings={'xray_config':str(source)};state=root/'control'
            job={'id':'a'*32,'device_id':device['id'],'action':'publish','payload':{}}
            with patch('devices.control.build_profiles',return_value={'clash.yaml':'node','shadowrocket.txt':'node','rules.conf':'rules'}):
                first=apply(registry,settings,state,job);self.assertTrue(first['ok']);self.assertNotIn('credential',first['credential'])
                self.assertEqual(apply(registry,settings,state,job),first)
                rotated=apply(registry,settings,state,{**job,'id':'b'*32,'action':'rotate'})
                self.assertNotEqual(first['token'],rotated['token'])
                self.assertEqual(apply(registry,settings,state,{**job,'id':'b'*32,'action':'rotate'})['token'],rotated['token'])
                renamed=apply(registry,settings,state,{**job,'id':'c'*32,'action':'rename','payload':{'label':'Work laptop'}})
                self.assertEqual(renamed['token'],rotated['token']);self.assertEqual(registry.find('Work laptop')['credential'],device['credential'])
                self.assertEqual((state/'jobs'/('c'*32+'.json')).stat().st_mode&0o777,0o600)
                self.assertEqual((state/'tokens'/(device['id']+'.json')).stat().st_mode&0o777,0o600)
    def test_revoke_missing_placeholder_and_reject_command_or_path_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);registry=Registry(root/'devices')
            job={'id':'a'*32,'device_id':'b'*24,'action':'revoke','payload':{},'credential':{'id':'b'*24,'label':'Uncreated','client':'clash','created':100}}
            result=apply(registry,{},root/'control',job);self.assertTrue(result['credential']['revoked']);self.assertTrue(result['ok'])
            for bad in [{**job,'action':'exec'},{**job,'device_id':'../../etc'},{**job,'payload':{'command':'whoami'}},{**job,'id':'../file'}]:
                with self.assertRaises(ValueError):apply(registry,{},root/'control',bad)
    def test_create_is_idempotent_and_does_not_replace_existing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);registry=Registry(root/'devices');source=root/'config.json';source.write_text('{}')
            job={'id':'a'*32,'device_id':'b'*24,'action':'create','payload':{'label':'Phone','client':'shadowrocket'}}
            def provision(registry,settings,label,client,identity=None):return registry.create(label,client,identity)
            with patch('devices.control._provision',side_effect=provision) as create,patch('devices.control.build_profiles',return_value={'clash.yaml':'a','shadowrocket.txt':'b','rules.conf':'c'}):
                first=apply(registry,{'xray_config':str(source)},root/'control',job)
                self.assertEqual(first,apply(registry,{'xray_config':str(source)},root/'control',job));self.assertEqual(create.call_count,1)
                self.assertEqual(registry.find('Phone')['id'],'b'*24)
                conflict=apply(registry,{'xray_config':str(source)},root/'control',{**job,'id':'c'*32,'device_id':'d'*24})
                self.assertEqual(conflict,{'ok':False,'error':'label_conflict'})
