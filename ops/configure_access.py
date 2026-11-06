"""Prepare or create a narrowly scoped Google Access application. Secrets stay local."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import urllib.error
import urllib.request
from deployment import DEFAULT_CONFIG, load_config, validate_admin


def private_read(path):
    path = Path(path).expanduser()
    m = path.lstat()
    if not stat.S_ISREG(m.st_mode) or m.st_nlink != 1 or m.st_uid != os.getuid() or m.st_mode & 0o077:
        raise ValueError('Private input must be an owned regular file with mode 0600')
    return path.read_text()


def save(path, value):
    path = Path(path)
    if path.exists(): private_read(path)
    fd, temporary = tempfile.mkstemp(prefix='.access-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n'); f.flush(); os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


class AccessAPI:
    def __init__(self, account, token):
        self.base = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/access'
        self.token = token

    def call(self, method, path, body=None):
        request = urllib.request.Request(self.base + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=30) as response: result = json.load(response)
        except urllib.error.HTTPError as error:
            raise ValueError(f'Access API rejected {method} {path.split("?")[0]} (HTTP {error.code}); check account/token permissions') from None
        except urllib.error.URLError:
            raise ValueError('Access API network failure; no automatic mutation retry') from None
        if not result.get('success'): raise ValueError('Access API operation failed')
        return result['result']

    def list(self, path):
        rows = []
        for page in range(1, 101):
            batch = self.call('GET', f'{path}?page={page}&per_page=100')
            rows.extend(batch)
            if len(batch) < 100: return rows
        raise ValueError('Too many Access resources; narrow the account')


def plan(config, issuer, idp_id, emails):
    a = {'issuer':issuer, 'aud':'a'*64, 'emails':emails}
    validate_admin({'admin_auth':'access','access':a})
    if not re.fullmatch(r'[a-f0-9-]{36}', idp_id): raise ValueError('Invalid Google identity provider ID')
    name = 'route-pilot-' + config['instance']['id'] + '-admin'
    host = config['status_hostname']
    policy = {'name':name, 'decision':'allow', 'include':[{'email':{'email':email.lower()}} for email in sorted(set(emails))],
              'require':[{'login_method':{'id':idp_id}}], 'exclude':[], 'session_duration':'8h'}
    app = {'name':name, 'type':'self_hosted', 'domain':host+'/admin',
           'destinations':[{'type':'public','uri':host+path} for path in ('/admin','/admin/*','/private/overview')],
           'allowed_idps':[idp_id], 'auto_redirect_to_identity':True, 'session_duration':'8h',
           'http_only_cookie_attribute':True, 'same_site_cookie_attribute':'lax',
           'app_launcher_visible':False, 'allow_authenticate_via_warp':False}
    return {'issuer':issuer, 'idp_id':idp_id, 'emails':emails, 'policy':policy, 'application':app}


def provision(api, candidate, checkpoint, write_checkpoint):
    # Only new resources or resources recorded by this command are managed.
    # Resume after partial failure without duplicating policies or applications.
    policy = candidate['policy']; app = candidate['application']
    policy_id = checkpoint.get('policy_id')
    if policy_id:
        current = api.call('GET', '/policies/'+policy_id)
        if any((current.get(k) or [] if isinstance(v,list) else current.get(k)) != v for k,v in policy.items()):
            raise ValueError('Recorded Access policy differs; review it before changing existing access')
    else:
        if any(p.get('name') == policy['name'] for p in api.list('/policies')):
            raise ValueError('Untracked policy with the same name exists; inspect it before adopting')
        policy_id = api.call('POST','/policies',policy)['id']
        checkpoint['policy_id'] = policy_id; write_checkpoint(checkpoint)
    desired = {**app, 'policies':[{'id':policy_id,'precedence':1}]}
    app_id = checkpoint.get('app_id')
    if app_id:
        current = api.call('GET','/apps/'+app_id)
        actual_destinations = current.get('destinations',[])
        destinations_match = sorted((d.get('type'),d.get('uri')) for d in actual_destinations) == sorted((d['type'],d['uri']) for d in app['destinations'])
        fields_match = all((bool(current.get(k)) if isinstance(v,bool) else current.get(k)) == v for k,v in app.items() if k != 'destinations')
        if not destinations_match or any(d.get('overrides') for d in actual_destinations) or not fields_match or [p['id'] for p in current.get('policies',[])] != [policy_id]:
            raise ValueError('Recorded Access application differs; review its protection before updating')
    else:
        if any(a.get('name') == app['name'] or a.get('domain') == app['domain'] for a in api.list('/apps')):
            raise ValueError('Untracked application already protects this path; review it before adopting')
        current = api.call('POST','/apps',desired)
        checkpoint['app_id'] = current['id']; write_checkpoint(checkpoint)
    audience = current.get('aud','')
    if not re.fullmatch(r'[a-f0-9]{64}', audience): raise ValueError('Access returned an invalid audience')
    return {'issuer':candidate['issuer'], 'aud':audience, 'emails':candidate['emails'],
            'idp_id':candidate['idp_id'], **checkpoint}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=str(DEFAULT_CONFIG))
    parser.add_argument('--token-file', required=True, help='Private CF API token file; never a literal token')
    parser.add_argument('--email', action='append', required=True, help='Exact allowed Google email; repeat for multiple administrators')
    parser.add_argument('--idp-id', help='Existing Google identity provider ID; inferred only if unambiguous')
    parser.add_argument('--apply', action='store_true', help='Create Access resources and save deployment settings; default only writes a private plan')
    args = parser.parse_args()
    path = Path(args.config).expanduser(); private_read(path)
    config = load_config(path)
    api = AccessAPI(config['account_id'], private_read(args.token_file).strip())
    org = api.call('GET','/organizations')
    domain = org.get('auth_domain','')
    providers = [p for p in api.list('/identity_providers') if p.get('type') == 'google']
    if args.idp_id: providers = [p for p in providers if p['id'] == args.idp_id]
    if len(providers) != 1:
        raise ValueError('Configure a Google identity provider in CF Zero Trust first, or select an existing one with --idp-id; see docs/admin-login.md')
    candidate = plan(config,'https://'+domain,providers[0]['id'],args.email)
    plan_path = path.with_name('access-plan.json'); save(plan_path,candidate)
    if not args.apply:
        print('Private Access plan saved:',plan_path)
        return
    journal = path.with_name('access-resources.json')
    checkpoint = json.loads(private_read(journal)) if journal.exists() else {}
    # Journal scope prevents resuming resources created for a different deployment.
    scope = config['account_id'] + ':' + config['status_hostname'] + ':' + config['instance']['id']
    if checkpoint.get('scope',scope) != scope: raise ValueError('Access checkpoint belongs to another deployment')
    checkpoint['scope'] = scope
    result = provision(api,candidate,checkpoint,lambda value:save(journal,value))
    result.pop('scope',None)
    if config.get('admin_auth') != 'access': save(path.with_name('before-access.json'),config)
    config.update(admin_auth='access',access=result)
    save(path,config)
    print('Access application prepared. Publish the Worker, then verify real Google login and public/subscription/report access.')


if __name__ == '__main__':
    try: main()
    except (ValueError,OSError,KeyError) as error: raise SystemExit(str(error)) from None
