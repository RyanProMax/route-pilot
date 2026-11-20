import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('mac_probe',Path(__file__).parents[1]/'ops/mac_probe.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class MacProbeTests(unittest.TestCase):
    def test_discover_excludes_tun_and_separates_families(self):
        text='''IPv4 network interface information:
     utun10 : flags : 0x7
     en1 : flags : 0x7
IPv6 network interface information:
     en0 : flags : 0x7
Network interfaces: en1 en0
'''
        self.assertEqual(m.physical_interfaces(text),{4:'en1',6:'en0'})
    def test_offline_is_missing_not_zero_or_failure(self):
        self.assertEqual(m.measure(None,4,None),{'family':4,'outcome':'unavailable','ms':None})
    def test_switch_discards_measurements(self):
        with patch.object(m,'echo_counts',return_value={'sent':3,'received':1}),patch.object(m,'discover',side_effect=[{4:'en0'},{4:'en1'}]),patch.object(m,'measure',return_value={'family':4,'outcome':'ok','ms':12}):
            result=m.collect({'ipv4':'192.0.2.1','port':443})
        self.assertNotIn('icmp',result)
        self.assertTrue(all(r['ms'] is None and r['outcome']=='unavailable' for r in result['results']))
    def test_icmp_counts_are_independent_of_tcp_outcomes(self):
        for received in (0, 2, 3):
            result = m.subprocess.CompletedProcess([], 2 if received == 0 else 0,
                f'3 packets transmitted, {received} packets received', '')
            with patch.object(m.subprocess, 'run', return_value=result) as run:
                self.assertEqual(m.echo_counts('192.0.2.1', 'en0'), {'sent':3, 'received':received})
                self.assertIn('en0', run.call_args.args[0])
        with patch.object(m.subprocess, 'run', side_effect=PermissionError()):
            self.assertIsNone(m.echo_counts('192.0.2.1', 'en0'))
        with patch.object(m.subprocess, 'run', return_value=m.subprocess.CompletedProcess([], 2,
                '3 packets transmitted, 0 packets received', 'ping: sendto: No route to host')):
            self.assertIsNone(m.echo_counts('192.0.2.1', 'en0'))

    def test_closed_window_adds_only_observed_echo_packets(self):
        import sys
        import tempfile
        with patch.object(sys, 'path', [str(Path(__file__).parents[1]/'cloud'), *sys.path]):
            from routepilot_aggregate import record, link_check
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'aggregate.sqlite3'
            for minute, packets in [(0, None), (1, {'sent':3,'received':0}), (2, {'sent':2,'received':2}), (20, None)]:
                report = {'ts':1200+60*minute,'results':[{'outcome':'ok','ms':100}], 'icmp':packets}
                result = record(path,1200,report['ts'],[link_check(report)],snapshot=report)
            check = result['windows'][0]['checks'][0]
            self.assertEqual((check['packets_sent'],check['packets_received'],check['latency_n']), (5,2,3))

    def test_bound_socket_and_timeout(self):
        with patch.object(m.socket,'socket') as factory,patch.object(m.socket,'if_nametoindex',return_value=7):
            s=factory.return_value.__enter__.return_value;s.connect.side_effect=TimeoutError()
            r=m.measure(('192.0.2.1',443),4,'en1')
            s.setsockopt.assert_called_once_with(m.socket.IPPROTO_IP,25,7)
            self.assertEqual(r['outcome'],'timeout');self.assertIsNone(r['ms'])
    def test_permission_error_is_unavailable(self):
        with patch.object(m.socket,'socket',side_effect=PermissionError()):
            self.assertEqual(m.measure(('192.0.2.1',443),4,'en1')['outcome'],'unavailable')

if __name__=='__main__':unittest.main()
