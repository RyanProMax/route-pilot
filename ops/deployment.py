"""Private deployment settings; public source contains no live account or host IDs."""
import copy
import ipaddress
import json
import os
from pathlib import Path
import re
import uuid

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = Path.home() / '.local/share/routepilot/deploy/production.json'

def load_config(path=None):
    path = Path(path or os.environ.get('ROUTEPILOT_DEPLOY_CONFIG', DEFAULT_CONFIG)).expanduser()
    c = json.loads(path.read_text())
    if not re.fullmatch(r'[a-f0-9]{32}', c['account_id']):
        raise ValueError('Set a valid Cloudflare account_id in the private deployment file')
    for key in ('zone', 'status_hostname'):
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', c[key]) or '.' not in c[key]:
            raise ValueError('Invalid deployment hostname')
        if key != 'zone' and not c[key].endswith('.' + c['zone']):
            raise ValueError('Hostname must belong to the deployment zone')
    i = c['instance']
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', i['id']): raise ValueError('Invalid instance ID')
    ipaddress.IPv4Address(i['ipv4'])
    if i.get('ipv6'): ipaddress.IPv6Address(i['ipv6'])
    if not re.fullmatch(r'[A-Z]{2}', i['country']): raise ValueError('Country must use ISO alpha-2')
    if not isinstance(i['name'], str) or not i['name'].strip(): raise ValueError('Instance name required')
    for value in (i['port'], c.get('stats_port', 10085)):
        if type(value) is not int or not 1 <= value <= 65535: raise ValueError('Invalid port')
    if type(i['bandwidth_gb']) is not int or i['bandwidth_gb'] <= 0: raise ValueError('Invalid traffic allowance')
    uuid.UUID(c['database']['id'])
    if not re.fullmatch(r'[a-z0-9-]+', c['database']['name']): raise ValueError('Invalid database name')
    return c

def cloud_configs(c):
    worker = json.loads((ROOT/'cloud/wrangler.json').read_text())
    site = json.loads((ROOT/'cloud/status-site.json').read_text())
    i = c['instance']; host = c['status_hostname']; zone = c['zone']
    worker.update(name='routepilot-'+i['id'], account_id=c['account_id'])
    worker['routes'] = [{'pattern':host,'custom_domain':True}] + [
        {'pattern':host+'/status/'+prefix+window+'.json','zone_name':zone}
        for prefix in ('', i['id']+'/') for window in ('24h','7d','30d')]
    worker['routes'].append({'pattern':host+'/status/'+i['id']+'/all.json','zone_name':zone})
    worker['d1_databases'] = [{'binding':'DB','database_name':c['database']['name'],
        'database_id':c['database']['id'],'migrations_dir':'migrations'}]
    worker['vars'] = {'INSTANCE_ID':i['id'],'IPV4':i['ipv4'],'IPV6':i.get('ipv6',''),
        'PORT':str(i['port']),'PLAN_BANDWIDTH_GB':str(i['bandwidth_gb'])}
    site.update(account_id=c['account_id'],routes=[{'pattern':host+'/*','zone_name':zone}])
    return worker, site
