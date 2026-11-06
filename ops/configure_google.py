"""Import a private Google Web OAuth client JSON into Worker Secrets without printing credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
from deployment import load_config, cloud_configs


def read_credentials(path,origin):
    path=Path(path).expanduser();metadata=path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_uid!=os.getuid() or metadata.st_mode & 0o077:
        raise ValueError('OAuth JSON must be an owned regular file with mode 0600')
    if metadata.st_size>65536:raise ValueError('Unexpected OAuth JSON size')
    document=json.loads(path.read_text())
    web=document.get('web') if isinstance(document,dict) else None
    if not isinstance(web,dict) or not isinstance(web.get('client_id'),str) or not re.fullmatch(r'[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com',web['client_id']):
        raise ValueError('Create a Google OAuth Web application client')
    secret=web.get('client_secret')
    if not isinstance(secret,str) or not 16<=len(secret)<=1024:raise ValueError('Missing Google client secret')
    redirects=web.get('redirect_uris')
    if not isinstance(redirects,list) or origin+'/private/auth/google/callback' not in redirects:
        raise ValueError('OAuth JSON does not include the exact deployed callback URI')
    return {'GOOGLE_CLIENT_ID':web['client_id'],'GOOGLE_CLIENT_SECRET':secret}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--credentials-file',required=True)
    parser.add_argument('--wrangler',default='wrangler')
    args=parser.parse_args();c=load_config(args.config)
    values=read_credentials(args.credentials_file,'https://'+c['status_hostname'])
    binary=shutil.which(args.wrangler)
    if not binary:parser.error('Install and authenticate Wrangler 4')
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='route-pilot-google-') as directory:
        stage=Path(directory)
        worker,_=cloud_configs(c)
        (stage/'wrangler.json').write_text(json.dumps({'name':worker['name'],'account_id':c['account_id']}))
        result=subprocess.run([binary,'secret','bulk','--config','wrangler.json'],input=json.dumps(values),
                              cwd=stage,capture_output=True,text=True,env={**os.environ,'WRANGLER_SEND_METRICS':'false'})
        if result.returncode:raise SystemExit('OAuth secret deployment failed; credentials withheld')
    print('Google credentials saved in Worker Secrets. Verify a real login, logout and denied account before acceptance.')


if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as error:raise SystemExit(str(error)) from None
