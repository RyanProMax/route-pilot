import unittest
from cloud.routepilot_devices import summarize
from devices.provision import xray_config

class DevicesTest(unittest.TestCase):
    def test_counts_registered_identities_not_connections_or_ips(self):
        a='rp.'+'a'*24+'@routepilot.invalid';b='rp.'+'b'*24+'@routepilot.invalid'
        self.assertEqual(summarize({'users':['user>>>'+a+'>>>online',a,b]}),2)
        self.assertEqual(summarize({}),0)
        self.assertEqual(summarize({'users':[a,'legacy-0@routepilot.invalid','legacy-0@routepilot.invalid']}),2)
        self.assertIsNone(summarize({'users':[a,'unmapped']}))
    def test_config_preserves_legacy_and_replaces_only_owned_devices(self):
        original={'inbounds':[{'protocol':'vless','streamSettings':{'security':'reality'},'settings':{'clients':[{'id':'old'}]}}]}
        c=xray_config(original,[{'id':'a'*24,'credential':'new','revoked':0}],10085)
        self.assertEqual(original['inbounds'][0]['settings']['clients'],[{'id':'old'}])
        self.assertEqual(c['api']['listen'],'127.0.0.1:10085')
        self.assertEqual(c['api']['services'],['StatsService'])
        self.assertEqual(len(c['inbounds'][0]['settings']['clients']),2)
        self.assertEqual(len(xray_config(c,[],10085)['inbounds'][0]['settings']['clients']),1)
    def test_unmanaged_api_not_overwritten(self):
        with self.assertRaises(ValueError):
            xray_config({'inbounds':[{'protocol':'vless','streamSettings':{'security':'reality'},'settings':{'clients':[]}}],'api':{'tag':'other'}},[],10085)
if __name__=='__main__':unittest.main()
