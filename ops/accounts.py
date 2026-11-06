"""Manage RP administrators in D1 using the operator's existing deployment credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from deployment import load_config, cloud_configs


def email_literal(value):
    if not isinstance(value,str) or len(value)>254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',value):
        raise ValueError('A valid email is required')
    return "'"+value.lower().replace("'","''")+"'"


def allow_sql(email, bootstrap=False):
    guard=' WHERE NOT EXISTS (SELECT 1 FROM rp_accounts)' if bootstrap else ''
    # Never re-enable or rebind an existing account during repeat deployment.
    return f"INSERT OR IGNORE INTO rp_accounts(id,email,role,disabled,created) SELECT '{secrets.token_hex(16)}',{email_literal(email)},'admin',0,{int(time.time())}{guard};"


def account_sql(action,email):
    value=email_literal(email)
    if action=='allow':return allow_sql(email)
    revoke=f'DELETE FROM rp_sessions WHERE account_id IN (SELECT id FROM rp_accounts WHERE email={value});'
    if action=='revoke-sessions':return revoke
    if action in ('enable','disable'):
        return f'UPDATE rp_accounts SET disabled={int(action=="disable")} WHERE email={value};\n'+revoke
    raise ValueError('Unknown account operation')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['list','allow','disable','enable','revoke-sessions'])
    parser.add_argument('--email')
    parser.add_argument('--config')
    parser.add_argument('--wrangler',default='wrangler')
    args=parser.parse_args()
    if args.action!='list' and not args.email:parser.error('--email is required')
    c=load_config(args.config);config,_=cloud_configs(c)
    binary=shutil.which(args.wrangler)
    if not binary:parser.error('Install and authenticate Wrangler 4')
    sql='SELECT email,role,disabled,google_sub IS NOT NULL AS linked,last_login FROM rp_accounts ORDER BY created;' if args.action=='list' else account_sql(args.action,args.email)
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='route-pilot-accounts-') as directory:
        stage=Path(directory)
        (stage/'wrangler.json').write_text(json.dumps(config))
        (stage/'accounts.sql').write_text(sql)
        result=subprocess.run([binary,'d1','execute',c['database']['name'],'--remote','--file','accounts.sql','--json',
                               '--config','wrangler.json'],cwd=stage,capture_output=True,text=True,
                              env={**os.environ,'WRANGLER_SEND_METRICS':'false'})
        if result.returncode:raise SystemExit('Account operation failed; check D1 deployment credentials')
        if args.action=='list':print(result.stdout)
        else:print('Account operation applied. Use list to verify the resulting status.')


if __name__=='__main__':main()
