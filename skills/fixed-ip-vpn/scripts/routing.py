"""Provider-neutral split routing: local services direct, sensitive egress pinned."""
from copy import deepcopy
import re

PINNED = ['binance.com','binance.us','binance.org','binance.info','binance.vision','bnbstatic.com','binanceapi.com','ifconfig.me','ipify.org','icanhazip.com','ipinfo.io']
DOMESTIC = ['qq.com','qpic.cn','qlogo.cn','weixin.com','wechat.com','weixin.qq.com','tenpay.com','gtimg.com','idqqimg.com','tencent.com','wechatpay.cn']
PRIVATE4 = ['127.0.0.0/8','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','169.254.0.0/16']
PRIVATE6 = ['::1/128','fc00::/7','fe80::/10']
BUILTIN = {'DIRECT','REJECT','REJECT-DROP','PASS'}
SUPPORTED = {'DOMAIN','DOMAIN-SUFFIX','DOMAIN-KEYWORD','IP-CIDR','IP-CIDR6','GEOIP','PROCESS-NAME','PROCESS-PATH','DST-PORT','SRC-PORT','NETWORK','MATCH'}

def normalize(source, group):
    """Keep order and built-in actions, map named proxy policies to one exit."""
    result=[]
    for rule in source:
        parts=rule.strip().split(',')
        if not parts or parts[0] not in SUPPORTED:
            raise ValueError('Unsupported imported rule; review dependencies before use')
        index=-2 if parts[-1]=='no-resolve' else -1
        if len(parts)<(2 if parts[0]=='MATCH' else 3):raise ValueError('Malformed rule')
        if parts[index] not in BUILTIN:parts[index]=group
        result.append(','.join(parts))
    return result

def rules(group, source=None):
    prefix=[f'DOMAIN-SUFFIX,{d},{group}' for d in PINNED]
    prefix += [f'IP-CIDR,{ip},DIRECT,no-resolve' for ip in PRIVATE4]
    prefix += [f'IP-CIDR6,{ip},DIRECT,no-resolve' for ip in PRIVATE6]
    prefix += [f'DOMAIN-SUFFIX,{d},DIRECT' for d in DOMESTIC]
    base=normalize(source,group) if source else ['GEOIP,CN,DIRECT','MATCH,'+group]
    if not any(r.startswith('MATCH,') for r in base):base+=['MATCH,'+group]
    if sum(r.startswith('MATCH,') for r in base)!=1 or not base[-1].startswith('MATCH,'):
        raise ValueError('Imported routing must have exactly one final MATCH rule')
    if not any(r=='GEOIP,CN,DIRECT' for r in base):base.insert(-1,'GEOIP,CN,DIRECT')
    # Stable de-duplication does not reorder the imported policy.
    return list(dict.fromkeys(prefix+base))

def dns(existing, compiled_rules):
    result=deepcopy(existing or {})
    domestic=['https://dns.alidns.com/dns-query','https://doh.pub/dns-query']
    policy={'+.cn':domestic}
    for rule in compiled_rules:
        parts=rule.split(',')
        if len(parts)>=3 and parts[2]=='DIRECT' and parts[0] in ('DOMAIN','DOMAIN-SUFFIX'):
            domain=parts[1]
            if re.fullmatch(r'[A-Za-z0-9_.-]+',domain):policy['+.'+domain if parts[0]=='DOMAIN-SUFFIX' else domain]=domestic
    result.update({'enable':True,'ipv6':False,'enhanced-mode':'fake-ip','fake-ip-range':'198.18.0.1/16',
        'respect-rules':True,'default-nameserver':['223.5.5.5','119.29.29.29'],
        'proxy-server-nameserver':domestic,'direct-nameserver':domestic,'direct-nameserver-follow-policy':True,
        'nameserver':['https://1.1.1.1/dns-query','https://8.8.8.8/dns-query'],'nameserver-policy':policy})
    result['fake-ip-filter']=list(dict.fromkeys(['*.lan','localhost','+.qq.com','+.qpic.cn','+.qlogo.cn','+.weixin.com','+.wechat.com']+result.get('fake-ip-filter',[])))
    result.pop('fallback',None);result.pop('fallback-filter',None)
    if 'skip-cert-verify' in str(result):raise ValueError('DNS certificate verification must not be bypassed')
    return result

def apply(profile, source=None):
    result=deepcopy(profile)
    groups=result.get('proxy-groups',[])
    if len(groups)!=1:raise ValueError('Expected a standalone single-group profile')
    result['rules']=rules(groups[0]['name'],source)
    result['dns']=dns(result.get('dns'),result['rules'])
    result['mode']='rule'
    return result

def shadowrocket():
    converted=[]
    for rule in rules('PROXY'):
        converted.append(rule.replace('MATCH,','FINAL,',1) if rule.startswith('MATCH,') else rule)
    return '# Independent node; Proxy Via: None. Use configuration mode.\n[General]\nipv6 = true\ndns-server = 223.5.5.5, 119.29.29.29\n\n[Rule]\n'+'\n'.join(converted)+'\n'
