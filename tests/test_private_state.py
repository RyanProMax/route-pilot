import json
from pathlib import Path
import tempfile
import unittest
from devices.registry import Registry
from devices import private
from devices.usage import summarize
from devices.security import protected_config


class PrivateStateTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)

    def test_redirected_database_and_profile_directories_fail_without_touching_target(self):
        external=self.root/'external';external.write_text('keep private')
        state=self.root/'state';state.mkdir();(state/'devices.db').symlink_to(external)
        with self.assertRaises(ValueError):Registry(state)
        self.assertEqual(external.read_text(),'keep private')
        (state/'devices.db').unlink();r=Registry(state)
        destination=self.root/'other';destination.mkdir()
        (state/'profiles').symlink_to(destination)
        with self.assertRaises(ValueError):r.write_profiles('a'*24,{'clash.yaml':'credential'})
        self.assertEqual(list(destination.iterdir()),[])

    def test_hardlinked_secret_is_not_overwritten_or_chmodded(self):
        original=self.root/'original';original.write_text('untouched');original.chmod(0o644)
        output=self.root/'output';output.hardlink_to(original)
        with self.assertRaises(ValueError):private.write(output,'replace')
        self.assertEqual(original.read_text(),'untouched')
        self.assertEqual(original.stat().st_mode&0o777,0o644)

    def test_credential_usage_is_shared_by_identity_and_omits_secrets(self):
        email='rp.'+'a'*24+'@routepilot.invalid'
        value=summarize({'users':[email,email]}, {'stat':[
            {'name':'user>>>'+email+'>>>traffic>>>uplink','value':'123'},
            {'name':'user>>>'+email+'>>>traffic>>>downlink','value':456}]}, {email:'Shared'})
        self.assertEqual(value['credentials'],[{'credential':'Shared','online':True,'uplink_bytes':123,'downlink_bytes':456}])
        self.assertNotIn(email,json.dumps(value))
        self.assertEqual(value['window'],'current_xray_process')

    def test_routing_guard_preserves_credentials_and_existing_routing(self):
        original={'inbounds':[{'secret':'unchanged'}],'outbounds':[{'tag':'deny','protocol':'blackhole'}],
                  'routing':{'rules':[{'type':'field','domain':['example.com'],'outboundTag':'direct'}]}}
        c=protected_config(original)
        self.assertEqual(c['inbounds'],original['inbounds'])
        self.assertEqual(c['routing']['rules'][1:],original['routing']['rules'])
        self.assertIn('169.254.0.0/16',c['routing']['rules'][0]['ip'])
        self.assertEqual(protected_config(c),c)
        self.assertNotIn('domainStrategy',original['routing'])
