import unittest
from datetime import datetime, timezone
from cloud.routepilot_accounting import advance


class AccountingTests(unittest.TestCase):
    def setUp(self):
        self.labels={'a':{'label':'Phone','revoked':False}}
        self.now=int(datetime(2026,11,5,tzinfo=timezone.utc).timestamp())

    def sample(self,old=None,delta=0,up=100,down=500,epoch='boot:1',readings=True):
        return advance(old,self.now+delta,epoch,[1000+delta*10,500+delta*5],
                       {'a':{'uplink':up,'downlink':down,'online':True}} if readings else {},self.labels)

    def test_baseline_increment_retry_and_restart(self):
        state,cpu,rows=self.sample()
        self.assertIsNone(cpu); self.assertEqual(rows[0]['uplink'],0)
        state,cpu,rows=self.sample(state,60,150,700)
        self.assertEqual(cpu,50); self.assertEqual(rows[0]['uplink'],50);self.assertEqual(rows[0]['downlink'],200)
        with self.assertRaises(ValueError): self.sample(state,60,150,700)
        state,_,rows=self.sample(state,120,10,20,'boot:2')
        self.assertEqual(rows[0]['uplink'],60);self.assertEqual(rows[0]['downlink'],220);self.assertEqual(rows[0]['gaps'],1)
        self.assertNotIn('raw',rows[0]);self.assertNotIn('epoch',rows[0])

    def test_missing_readings_do_not_reset_or_double_count(self):
        state,_,_=self.sample()
        state,_,rows=self.sample(state,60,readings=False)
        self.assertFalse(rows[0]['online'])
        state,_,rows=self.sample(state,120,150,700)
        self.assertEqual(rows[0]['uplink'],50);self.assertEqual(rows[0]['gaps'],0)

    def test_month_rollover_splits_single_interval(self):
        self.now=int(datetime(2026,11,30,23,59,30,tzinfo=timezone.utc).timestamp())
        state,_,_=self.sample()
        state,_,rows=self.sample(state,60,200,700)
        self.assertEqual(rows[0]['month'],'2026-12');self.assertEqual(rows[0]['uplink'],50)
        self.assertEqual(rows[0]['downlink'],100)

    def test_reboot_and_revoked_identity_history(self):
        state,_,_=self.sample()
        state,_,_=self.sample(state,60,150,700)
        self.labels={}
        state,cpu,rows=self.sample(state,120,readings=False,epoch='newboot:2')
        self.assertIsNone(cpu);self.assertTrue(rows[0]['revoked']);self.assertEqual(rows[0]['uplink'],50)

if __name__=='__main__':unittest.main()
