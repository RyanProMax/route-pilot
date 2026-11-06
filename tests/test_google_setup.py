import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ops'))
from accounts import allow_sql,account_sql
from configure_google import read_credentials
from deployment import cloud_configs


class GoogleSetupTests(unittest.TestCase):
    def test_bootstrap_does_not_restore_disabled_accounts_and_operator_revocation(self):
        db=sqlite3.connect(':memory:')
        try:
            root=Path(__file__).resolve().parents[1]
            for name in ['0004_private_control.sql','0005_google_accounts.sql']:
                db.executescript((root/'cloud/migrations'/name).read_text())
            db.executescript(allow_sql('Admin@example.com',bootstrap=True))
            row=db.execute('SELECT id,email FROM rp_accounts').fetchone()
            self.assertEqual(row[1],'admin@example.com')
            db.execute("UPDATE rp_accounts SET disabled=1,google_sub='subject-1'")
            db.executescript(allow_sql('another@example.com',bootstrap=True))
            db.executescript(allow_sql('admin@example.com'))
            self.assertEqual(db.execute('SELECT count(*) FROM rp_accounts').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT disabled,google_sub FROM rp_accounts').fetchone(),(1,'subject-1'))
            db.executescript(account_sql('enable','admin@example.com'))
            db.execute('INSERT INTO rp_sessions(hash,account_id,expires) VALUES(?,?,?)',('hash',row[0],9999999999))
            db.executescript(account_sql('disable','admin@example.com'))
            self.assertEqual(db.execute('SELECT count(*) FROM rp_sessions').fetchone()[0],0)
            db.executescript(allow_sql("o'hara@example.com"))
            self.assertEqual(db.execute('SELECT count(*) FROM rp_accounts').fetchone()[0],2)
        finally:db.close()

    def test_google_json_requires_web_client_exact_callback_and_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            p=Path(directory)/'google.json'
            value={'web':{'client_id':'test.apps.googleusercontent.com','client_secret':'x'*32,
                          'redirect_uris':['https://status.example.com/private/auth/google/callback']}}
            p.write_text(json.dumps(value));p.chmod(0o600)
            self.assertEqual(set(read_credentials(p,'https://status.example.com')),{'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'})
            with self.assertRaises(ValueError):read_credentials(p,'https://another.example.com')
            link=Path(directory)/'link';link.symlink_to(p)
            with self.assertRaises(ValueError):read_credentials(link,'https://status.example.com')
            p.chmod(0o644)
            with self.assertRaises(ValueError):read_credentials(p,'https://status.example.com')
            p.chmod(0o600);p.write_text(json.dumps({'installed':value['web']}))
            with self.assertRaises(ValueError):read_credentials(p,'https://status.example.com')
            for malformed in [[],{'web':[]},{'web':{'client_id':None}},
                              {'web':{**value['web'],'redirect_uris':None}}]:
                p.write_text(json.dumps(malformed))
                with self.assertRaises(ValueError):read_credentials(p,'https://status.example.com')

    def test_deployment_keeps_account_email_and_google_secrets_out_of_worker_vars(self):
        c=json.loads((Path(__file__).resolve().parents[1]/'examples/deploy.example.json').read_text())
        worker,_=cloud_configs(c)
        self.assertEqual(worker['name'],'routepilot-server')
        self.assertEqual(cloud_configs(c)[1]['name'],'routepilot-web')
        custom={**c,'server_worker':'another-server','web_worker':'another-web'}
        self.assertEqual(cloud_configs(custom)[0]['name'],'another-server')
        self.assertEqual(cloud_configs(custom)[1]['name'],'another-web')
        self.assertEqual(worker['vars']['APP_ORIGIN'],'https://status.example.com')
        self.assertNotIn(c['bootstrap_admin_email'],json.dumps(worker))
        self.assertNotIn('GOOGLE_CLIENT_SECRET',worker['vars'])


if __name__=='__main__':unittest.main()
