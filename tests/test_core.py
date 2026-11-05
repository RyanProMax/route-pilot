import functools
import gc
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/'skills/fixed-ip-vpn/scripts'))
from routepilot.store import Store
from routepilot.daemon import Handler
import routing
from ops.bootstrap import daily_proxy, trusted_keys
from routepilot.probes import host_metrics


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.tmp.name)/'test.db',60)
    def tearDown(self):self.tmp.cleanup()
    def test_absent_samples_are_unknown(self):
        s=self.store.summarize('a',3600,now=4000)
        self.assertEqual(s['status'],'unknown');self.assertIsNone(s['success_rate'])
        self.assertEqual(s['coverage'],0);self.assertTrue(all(b['status']=='unknown' for b in s['history']))
    def test_sleep_gap_is_not_counted_as_success(self):
        self.store.add('a','ok',{},100,ts=1000)
        self.store.add('a','ok',{},200,ts=3000)
        s=self.store.summarize('a',3600,now=3100)
        self.assertAlmostEqual(s['coverage'],120/3600*100,places=2)
        self.assertEqual(s['success_rate'],100)
        self.assertGreater(sum(b['status']=='unknown' for b in s['history']),60)
    def test_expired_success_is_unknown(self):
        self.store.add('a','ok',{},100,ts=1000)
        self.assertEqual(self.store.summarize('a',3600,now=1151)['status'],'unknown')
    def test_latency_excludes_failures_and_unknown(self):
        for status,latency,ts in [('ok',100,1000),('down',5000,1060),('unknown',None,1120),('degraded',600,1180)]:self.store.add('a',status,{},latency,ts)
        s=self.store.summarize('a',3600,now=1200)
        self.assertEqual(s['samples'],3);self.assertEqual(s['success_rate'],66.67);self.assertEqual(s['p95'],600)
    def test_persists_and_deduplicates_state_events(self):
        for ts,status in [(1000,'ok'),(1060,'down'),(1120,'down'),(1180,'ok')]:self.store.add('a',status,{},None,ts)
        reopened=Store(self.store.path)
        self.assertEqual(len(reopened.events(0)),2)
        self.assertEqual(reopened.summarize('a',3600,now=1200)['status'],'ok')
    def test_rejects_nonfinite_latency(self):
        with self.assertRaises(ValueError):self.store.add('a','ok',{},float('nan'))
    def test_connections_close_without_waiting_for_gc(self):
        gc.collect()
        before=len(os.listdir('/dev/fd'))
        gc.disable()
        try:
            for i in range(350):self.store.meta('iteration',i)
            self.assertLessEqual(len(os.listdir('/dev/fd')),before+2)
        finally:gc.enable()


class DeploymentTests(unittest.TestCase):
    def test_daily_probe_uses_rules_listener_not_fixed_cli(self):
        self.assertEqual(daily_proxy({'mixed-port':9997,'listeners':[{'port':9998,'type':'mixed','proxy':'VPS'}]}),'http://127.0.0.1:9997')
        with self.assertRaises(ValueError):daily_proxy({'listeners':[{'port':9998}]})
    def test_nonstandard_trusted_host_port(self):
        with tempfile.TemporaryDirectory() as tmp:
            key=Path(tmp)/'key'
            subprocess.run(['/usr/bin/ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],check=True)
            known=Path(tmp)/'known_hosts'
            known.write_text('[203.0.113.10]:22222 '+Path(str(key)+'.pub').read_text())
            self.assertEqual(len(trusted_keys(known,'203.0.113.10','2001:db8::10',22222)),1)
    def test_managed_proxy_service_is_healthy(self):
        cfg={'interface':'en1','ipv6':'2001:db8::10','ssh':{'port':22222,'monitor_key':'/unused','known_hosts':'/unused','monitor_user':'test'}}
        result=subprocess.CompletedProcess([],0,json.dumps({'schema':1,'services':{'fixed-ip-vpn':'active','xray':'inactive'}}),'')
        with mock.patch('routepilot.probes.subprocess.run',return_value=result):self.assertEqual(host_metrics(cfg)[0],'ok')
    def test_candidate_same_path_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'profile.json';p.write_text('{"original":true}')
            before=p.read_bytes()
            result=subprocess.run([sys.executable,str(ROOT/'ops/apply_routing.py'),'--profile',str(p),'--out',str(p),'--data-dir',tmp,'--mihomo','/usr/bin/false'],capture_output=True)
            self.assertNotEqual(result.returncode,0);self.assertEqual(p.read_bytes(),before)
    def test_invalid_candidate_preserves_output_and_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'profile.json';p.write_text(json.dumps({'proxy-groups':[{'name':'VPS','type':'select','proxies':['DIRECT']}],'rules':['MATCH,VPS']}))
            out=Path(tmp)/'candidate.json';out.write_text('previous candidate')
            before=p.read_bytes()
            result=subprocess.run([sys.executable,str(ROOT/'ops/apply_routing.py'),'--profile',str(p),'--out',str(out),'--data-dir',tmp,'--mihomo','/usr/bin/false','--apply'],capture_output=True)
            self.assertNotEqual(result.returncode,0);self.assertEqual(p.read_bytes(),before);self.assertEqual(out.read_text(),'previous candidate')


class RoutingTests(unittest.TestCase):
    def test_priority_and_policy_mapping(self):
        compiled=routing.rules('VPS',['DOMAIN-SUFFIX,binance.com,DIRECT','DOMAIN-SUFFIX,example.org,Foreign','GEOIP,CN,DIRECT','MATCH,DIRECT'])
        self.assertLess(compiled.index('DOMAIN-SUFFIX,binance.com,VPS'),compiled.index('DOMAIN-SUFFIX,binance.com,DIRECT'))
        self.assertIn('DOMAIN-SUFFIX,example.org,VPS',compiled)
        self.assertEqual(compiled[-1],'MATCH,DIRECT')
        self.assertIn('DOMAIN-SUFFIX,qpic.cn,DIRECT',compiled)
    def test_unsupported_rule_dependencies_fail_closed(self):
        with self.assertRaises(ValueError):routing.rules('VPS',['RULE-SET,missing,DIRECT','MATCH,VPS'])
    def test_dns_uses_domestic_resolver_without_tls_bypass(self):
        d=routing.dns({},routing.rules('VPS'))
        self.assertEqual(d['nameserver-policy']['+.qq.com'],d['direct-nameserver'])
        self.assertNotIn('skip-cert-verify',json.dumps(d))
    def test_shadowrocket_pins_business_before_domestic(self):
        config=routing.shadowrocket()
        self.assertLess(config.index('binance.com,PROXY'),config.index('GEOIP,CN,DIRECT'))
        self.assertTrue(config.endswith('FINAL,PROXY\n'))


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();Path(self.tmp.name,'index.html').write_text('route-pilot')
        class Fake:
            config={'interval':60}
            def summary(self,window):return {'window':window}
        self.server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=self.tmp.name,monitor=Fake()))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def test_summary_read_and_security_headers(self):
        with self.opener.open(self.url+'/api/summary?window=7d') as r:
            self.assertEqual(json.load(r)['window'],604800)
            self.assertEqual(r.headers['X-Frame-Options'],'DENY')
    def test_untrusted_host_and_origin_rejected(self):
        for headers in [{'Host':'evil.example'},{'Origin':'https://evil.example'}]:
            with self.assertRaises(urllib.error.HTTPError) as e:self.opener.open(urllib.request.Request(self.url+'/api/summary',headers=headers))
            self.assertEqual(e.exception.code,403)
            e.exception.close()
    def test_invalid_window_and_mutation_rejected(self):
        for request in [urllib.request.Request(self.url+'/api/summary?window=all'),urllib.request.Request(self.url+'/api/summary',data=b'{}',method='POST')]:
            with self.assertRaises(urllib.error.HTTPError) as e:self.opener.open(request)
            self.assertIn(e.exception.code,[400,501])
            e.exception.close()


if __name__=='__main__':unittest.main()
