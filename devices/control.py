"""Execute a bounded, declarative credential operation; never accept commands or paths."""
import base64
import json
from pathlib import Path
import re
import secrets
from devices import private
from devices.provision import _provision, build_profiles, revoke

ACTIONS={'create','rename','revoke','rotate','publish'}

def describe(device):
    return {**{k:device[k] for k in ('id','label','client','created')},'revoked':bool(device['revoked'])}

def apply(registry,settings,state,job):
    if not isinstance(job,dict) or job.get('action') not in ACTIONS or not re.fullmatch(r'[a-f0-9]{32}',job.get('id','')) or not re.fullmatch(r'[a-f0-9]{24}',job.get('device_id','')):
        raise ValueError('Invalid operation')
    payload=job.get('payload',{})
    if not isinstance(payload,dict) or set(payload)-{'label','client'}:raise ValueError('Invalid payload')
    if job['action'] in ('create','rename'):
        label=payload.get('label')
        if not isinstance(label,str) or not label.strip() or label!=label.strip() or len(label)>80 or any(ord(c)<32 or ord(c)==127 for c in label):raise ValueError('Invalid label')
    if job['action']=='create' and payload.get('client') not in ('clash','shadowrocket'):raise ValueError('Invalid client')
    state=private.directory(state);results=private.directory(state/'jobs');tokens=private.directory(state/'tokens')
    cached=results/(job['id']+'.json')
    if cached.exists():return json.loads(private.regular(cached).read_text())
    device=next((d for d in registry.devices(True) if d['id']==job['device_id']),None)
    if job['action']=='revoke':
        if device and not device['revoked']:revoke(registry,settings,device['id'])
        if not device:
            metadata=job.get('credential',{})
            if metadata.get('id')!=job['device_id'] or not {'label','client','created'}<=metadata.keys():return {'ok':False,'error':'unknown_credential'}
            device=metadata
        device['revoked']=1
        result={'ok':True,'credential':describe(device)}
    else:
        with registry.administration():
            device=next((d for d in registry.devices(True) if d['id']==job['device_id']),None)
            if job['action']=='create':
                if device and device['revoked']:return {'ok':False,'error':'unknown_credential'}
                existing=registry.find(payload['label'])
                if existing and existing['id']!=job['device_id']:return {'ok':False,'error':'label_conflict'}
                if not device and (len(registry.devices())>=32 or len(registry.devices(True))>=512):return {'ok':False,'error':'apply_failed'}
                device=_provision(registry,settings,payload['label'],payload['client'],identity=job['device_id'])
            elif not device or device['revoked']:return {'ok':False,'error':'unknown_credential'}
            if job['action']=='rename':
                existing=registry.find(payload['label'])
                if existing and existing['id']!=device['id']:return {'ok':False,'error':'label_conflict'}
                with registry.connect() as db:db.execute('UPDATE devices SET label=? WHERE id=?',(payload['label'],device['id']))
                device['label']=payload['label']
            source=json.loads(Path(settings['xray_config']).read_text())
            files=build_profiles(source,device,settings)
            files['shadowrocket.txt']=base64.b64encode(files['shadowrocket.txt'].encode()).decode()+'\n'
            token_file=tokens/(device['id']+'.json')
            current=json.loads(private.regular(token_file).read_text()) if token_file.exists() else {}
            if not current or (job['action']=='rotate' and current.get('job')!=job['id']):
                current={'token':secrets.token_urlsafe(32),'job':job['id']};private.write(token_file,json.dumps(current))
            result={'ok':True,'credential':describe(device),'files':files,'token':current['token']}
    private.write(cached,json.dumps(result))
    return result
