#!/usr/bin/env python3
"""Isolated behavioral tests. No production SSH, router, firewall or service mutation."""
import argparse, copy, json, os, socket, subprocess, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse,parse_qs
import render, apply_server, probe, verify
BINARIES={}
EXAMPLE=Path(__file__).resolve().parent.parent/'references/inventory.example.json'

class FakeHost:
    def __init__(self): self.active=False;self.enabled=False;self.fail=False;self.activations=0
    def state(self): return dict(active=self.active,enabled=self.enabled)
    def activate(self):
        self.activations+=1;self.active=True;self.enabled=True
        if self.fail: raise RuntimeError('startup failure')
    def restore(self,state): self.active=state['active'];self.enabled=state['enabled']

class Workflow(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.out=self.root/'bundle'
        self.inventory=json.loads(EXAMPLE.read_text());self.inv=self.root/'inventory.json';self.inv.write_text(json.dumps(self.inventory))
        render.render(self.inv,self.out)
    def tearDown(self): self.temp.cleanup()
    def client(self): return json.loads((self.out/'clash-verge.yaml').read_text())
    def server(self): return json.loads((self.out/'xray-server.json').read_text())
    def test_repeat_preserves_credentials_and_profiles(self):
        before={p.name:p.read_bytes() for p in self.out.iterdir()}
        render.render(self.inv,self.out)
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.out.iterdir()})
        self.assertTrue(all(p.stat().st_mode & 0o777==0o600 for p in self.out.iterdir()))
        self.assertEqual(self.out.stat().st_mode & 0o777,0o700)
    def test_cross_client_identity_and_fixed_egress(self):
        c=self.client();s=self.server();keys=json.loads((self.out/'credentials.json').read_text())
        self.assertEqual(s['outbounds'][0]['sendThrough'],self.inventory['egress_ipv4'])
        self.assertEqual(apply_server.validate_config(json.dumps(s)),(self.inventory['egress_ipv4'],443))
        self.assertEqual(c['proxy-groups'][0]['type'],'url-test')
        self.assertEqual(c['rules'][-1],'MATCH,Tokyo-Fixed-IP')
        self.assertNotIn('DIRECT',c['proxy-groups'][0]['proxies'])
        self.assertNotIn('proxy-providers',c)
        for node in c['proxies']:
            self.assertNotIn('dialer-proxy',node);self.assertEqual(node['uuid'],keys['uuid'])
            self.assertEqual(node['reality-opts']['public-key'],render.public_key(keys['private_key']))
        for name in ['clash-verge.yaml','shadowrocket-nodes.txt','shadowrocket-rules.conf','manifest.json']:
            self.assertNotIn(keys['private_key'],(self.out/name).read_text())
        links=(self.out/'shadowrocket-nodes.txt').read_text().splitlines()
        first=urlparse(links[0]);self.assertEqual(first.hostname,self.inventory['server_ipv6'])
        self.assertEqual(first.username,keys['uuid']);self.assertEqual(parse_qs(first.query)['sni'],[self.inventory['reality_server_name']])
    def test_ipv4_only_and_bad_ports(self):
        i=copy.deepcopy(self.inventory);i.pop('server_ipv6');c=json.loads(render.build(i,render.credentials(self.out/'credentials.json'))['clash-verge.yaml'])
        self.assertEqual(len(c['proxies']),1);self.assertEqual(c['proxies'][0]['server'],i['server_ipv4'])
        i['cli_port']=i['mixed_port']
        with self.assertRaises(ValueError):render.validate_inventory(i)
    def test_reject_unsafe_credentials_and_symlink(self):
        p=self.out/'credentials.json';p.chmod(0o644)
        with self.assertRaises(ValueError):render.render(self.inv,self.out)
        p.chmod(0o600);target=self.root/'do-not-overwrite';target.write_text('original')
        f=self.out/'clash-verge.yaml';f.unlink();f.symlink_to(target)
        with self.assertRaises(ValueError):render.render(self.inv,self.out)
        self.assertEqual(target.read_text(),'original')
    def test_server_transaction_and_rollback(self):
        root=self.root/'host';host=FakeHost();content=(self.out/'xray-server.json').read_text();unit=apply_server.unit('/usr/local/bin/xray')
        first=apply_server.transact(root,content,unit,host);self.assertTrue(first['changed'])
        self.assertFalse(apply_server.transact(root,content,unit,host)['changed']);self.assertEqual(host.activations,1)
        config,service,_=apply_server.paths(root);host.fail=True
        with self.assertRaisesRegex(RuntimeError,'automatic rollback completed'):
            apply_server.transact(root,content+'\n',unit,host)
        self.assertEqual(config.read_text(),content);self.assertTrue(host.active);self.assertTrue(host.enabled)
        host.fail=False;apply_server.restore(root,Path(first['backup']),host)
        self.assertFalse(config.exists());self.assertFalse(service.exists());self.assertFalse(host.active);self.assertFalse(host.enabled)
    def test_reject_unmanaged_service_and_bad_guard(self):
        root=self.root/'host';_,service,_=apply_server.paths(root);service.parent.mkdir(parents=True);service.write_text('other owner')
        with self.assertRaises(ValueError):apply_server.transact(root,'{}',apply_server.unit('/usr/local/bin/xray'),FakeHost())
        self.assertEqual(service.read_text(),'other owner')
        s=self.server();s['routing']['rules']=[]
        with self.assertRaises(ValueError):apply_server.validate_config(json.dumps(s))
    def test_failed_first_install_leaves_no_service(self):
        root=self.root/'host';host=FakeHost();host.fail=True
        with self.assertRaisesRegex(RuntimeError,'automatic rollback completed'):
            apply_server.transact(root,(self.out/'xray-server.json').read_text(),apply_server.unit('/usr/local/bin/xray'),host)
        config,service,_=apply_server.paths(root)
        self.assertFalse(config.exists());self.assertFalse(service.exists());self.assertFalse(host.active);self.assertFalse(host.enabled)
    def test_probe_scope_and_interface_failure(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));listener.listen(1);port=listener.getsockname()[1]
            self.assertTrue(probe.probe('127.0.0.1',port,None)['tcp_connected'])
            self.assertFalse(probe.probe('127.0.0.1',port,'no-such-interface')['tcp_connected'])
    def test_egress_verifier_clears_env_and_rejects_wrong_ip(self):
        good=subprocess.CompletedProcess([],0,'203.0.113.10\n200\n0.2','')
        with patch.dict(os.environ,{'HTTP_PROXY':'http://unwanted:1','all_proxy':'socks5://unwanted:2'}),patch('verify.subprocess.run',return_value=good) as call:
            self.assertTrue(verify.check('https://ifconfig.me/ip','203.0.113.10')['passed'])
            kwargs=call.call_args.kwargs
            self.assertNotIn('HTTP_PROXY',kwargs['env']);self.assertNotIn('all_proxy',kwargs['env'])
            self.assertIn('*',call.call_args.args[0])
        bad=subprocess.CompletedProcess([],0,'203.0.113.11\n200\n0.2','')
        with patch('verify.subprocess.run',return_value=bad):self.assertFalse(verify.check('https://ifconfig.me/ip','203.0.113.10')['passed'])
        error_status=subprocess.CompletedProcess([],0,'203.0.113.10\n500\n0.2','')
        with patch('verify.subprocess.run',return_value=error_status):self.assertFalse(verify.check('https://ifconfig.me/ip','203.0.113.10')['passed'])
    def test_real_mihomo_syntax(self):
        if not BINARIES.get('mihomo'):self.skipTest('Mihomo binary not provided')
        r=subprocess.run([BINARIES['mihomo'],'-t','-d',str(self.root/'mihomo'),'-f',str(self.out/'clash-verge.yaml')],capture_output=True)
        self.assertEqual(r.returncode,0,'Mihomo rejected generated configuration')
    def test_real_xray_syntax(self):
        if not BINARIES.get('xray'):self.skipTest('Xray binary not provided')
        r=subprocess.run([BINARIES['xray'],'run','-test','-config',str(self.out/'xray-server.json')],capture_output=True)
        self.assertEqual(r.returncode,0,'Xray rejected generated configuration')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--mihomo');p.add_argument('--xray');a=p.parse_args();BINARIES.update(vars(a))
    unittest.main(argv=['test_workflow'],verbosity=2)
