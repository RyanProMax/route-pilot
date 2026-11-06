import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ops'))
from configure_access import plan, provision
from deployment import cloud_configs, validate_admin


class AccessSetupTests(unittest.TestCase):
    def setUp(self):
        self.config=json.loads((Path(__file__).resolve().parents[1]/'examples/deploy.example.json').read_text())
        self.candidate=plan(self.config,'https://example-team.cloudflareaccess.com',
                            '00000000-0000-4000-8000-000000000001',['admin@example.com'])

    def test_only_admin_paths_protected(self):
        app=self.candidate['application']
        self.assertEqual({r['uri'] for r in app['destinations']},{'status.example.com/admin','status.example.com/admin/*','status.example.com/private/overview'})
        self.assertEqual(app['allowed_idps'],[self.candidate['idp_id']])
        self.assertEqual(self.candidate['policy']['include'],[{'email':{'email':'admin@example.com'}}])
        self.assertEqual(self.candidate['policy']['require'],[{'login_method':{'id':self.candidate['idp_id']}}])

    def test_access_deployment_requires_complete_configuration(self):
        for config in [{'admin_auth':'accses'},{'admin_auth':'access','access':{}},
                       {'admin_auth':'access','access':{'issuer':'https://example-team.cloudflareaccess.com','aud':'a'*64,'emails':[]}}]:
            with self.assertRaises(ValueError):validate_admin(config)
        c=copy.deepcopy(self.config)
        c.update(admin_auth='access',access={'issuer':self.candidate['issuer'],'aud':'a'*64,'emails':['admin@example.com']})
        worker,_=cloud_configs(c)
        self.assertEqual(worker['vars']['ADMIN_AUTH_MODE'],'access')
        self.assertNotIn('admin@example.com',json.dumps(worker))
        patterns=[r['pattern'] for r in worker['routes']]
        self.assertIn('status.example.com/sub/*',patterns)
        self.assertIn('status.example.com/private/*',patterns)

    def test_partial_failure_is_resumable_without_duplicate_resources(self):
        class API:
            def __init__(self):self.policy=None;self.app=None;self.fail=True;self.creates=[]
            def list(self,path):return []
            def call(self,method,path,body=None):
                if method=='GET':return self.policy if path.startswith('/policies/') else self.app
                if path=='/apps' and self.fail:raise ValueError('injected failure')
                self.creates.append(path)
                if path=='/policies':self.policy={**body,'id':'policy-id'};return self.policy
                self.app={**body,'id':'app-id','aud':'b'*64};return self.app
        api=API();journal={};saved=[]
        with self.assertRaises(ValueError):provision(api,self.candidate,journal,lambda c:saved.append(dict(c)))
        self.assertEqual(saved,[{'policy_id':'policy-id'}])
        api.fail=False
        result=provision(api,self.candidate,journal,lambda c:saved.append(dict(c)))
        self.assertEqual(result['aud'],'b'*64)
        provision(api,self.candidate,journal,lambda c:saved.append(dict(c)))
        self.assertEqual(api.creates,['/policies','/apps'])
        api.policy['include']=[{'everyone':{}}]
        with self.assertRaises(ValueError):provision(api,self.candidate,journal,lambda c:None)


if __name__=='__main__':unittest.main()
