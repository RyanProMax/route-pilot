import {createRemoteJWKSet, jwtVerify} from 'jose';

const encoder = new TextEncoder();
const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2,'0')).join('');
export const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const sessionName = '__Host-routepilot', flowName = '__Host-routepilot_oauth';
export const privateHeaders = {'Cache-Control':'private, no-store', 'CDN-Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Robots-Tag':'noindex, nofollow'};
const json = (body,status=200,extra={}) => Response.json(body,{status,headers:{...privateHeaders,...extra}});
const cookieValue = (request,name) => {
  const values=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));
  const value=values[0]?.slice(name.length+1);
  return values.length===1 && /^[a-f0-9]{64}$/.test(value??'') ? value : null;
};
const cookie = (name,value,age) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const originOK = (request,env) => request.headers.get('origin') === env.APP_ORIGIN && new URL(request.url).origin === env.APP_ORIGIN;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'),
  {timeoutDuration:5000,cooldownDuration:30000,cacheMaxAge:600000});

export function googleReady(env) {
  let origin;
  try{origin=new URL(env.APP_ORIGIN);}catch{return false;}
  return origin.protocol==='https:' && origin.origin===env.APP_ORIGIN &&
    /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID??'') &&
    typeof env.GOOGLE_CLIENT_SECRET==='string' && env.GOOGLE_CLIENT_SECRET.length>=16 && env.GOOGLE_CLIENT_SECRET.length<=1024;
}
export async function authenticatedAccount(request,env,now) {
  const token=cookieValue(request,sessionName);
  if(!token || new URL(request.url).origin!==env.APP_ORIGIN)return null;
  return env.DB.prepare(`SELECT a.id,a.role FROM rp_sessions s JOIN rp_accounts a ON a.id=s.account_id
    WHERE s.hash=? AND s.expires>? AND a.disabled=0 AND a.role='admin'`)
    .bind(await digest(token),now).first();
}
async function limitedJSON(response) {
  if(!response.ok || !response.headers.get('content-type')?.includes('application/json'))throw Error('exchange');
  const reader=response.body?.getReader();if(!reader)throw Error('exchange');
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>32768){await reader.cancel();throw Error('exchange');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function googleIdentity(token,env,nonceHash,now,resolveKey=googleKeys) {
  if(typeof token!=='string' || token.length>16384)throw Error('identity');
  const {payload}=await jwtVerify(token,resolveKey,{algorithms:['RS256'],
    issuer:['https://accounts.google.com','accounts.google.com'],audience:env.GOOGLE_CLIENT_ID,
    requiredClaims:['exp','iat','sub','email','email_verified','nonce'],maxTokenAge:'10m',clockTolerance:5,currentDate:new Date(now*1000)});
  if(payload.email_verified!==true || typeof payload.email!=='string' || payload.email.length>254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || typeof payload.sub!=='string' || !payload.sub || payload.sub.length>255 ||
    typeof payload.nonce!=='string' || await digest(payload.nonce)!==nonceHash ||
    (payload.azp!==undefined && payload.azp!==env.GOOGLE_CLIENT_ID) ||
    (Array.isArray(payload.aud) && payload.aud.length>1 && payload.azp!==env.GOOGLE_CLIENT_ID))throw Error('identity');
  return {sub:payload.sub,email:payload.email.toLowerCase()};
}
function finish(error,sessionToken) {
  const headers=new Headers(privateHeaders);
  headers.set('Location','/admin/'+(error?'?login='+error:''));
  headers.append('Set-Cookie',cookie(flowName,'',0));
  if(sessionToken)headers.append('Set-Cookie',cookie(sessionName,sessionToken,8*3600));
  return new Response(null,{status:303,headers});
}

// Dependencies can be injected by isolated tests; HTTP callers cannot supply them.
export async function authAPI(request,env,now,{fetchToken=fetch,resolveKey=googleKeys}={}) {
  const url=new URL(request.url),path=url.pathname;
  if(path==='/private/auth' && request.method==='GET' && !url.search)return json({provider:'google',ready:googleReady(env)});
  if(path==='/private/session' && request.method==='DELETE' && !url.search){
    if(!originOK(request,env))return json({error:'Forbidden'},403);
    const value=cookieValue(request,sessionName),flow=cookieValue(request,flowName);
    const statements=[];
    if(value)statements.push(env.DB.prepare('DELETE FROM rp_sessions WHERE hash=?').bind(await digest(value)));
    if(flow)statements.push(env.DB.prepare('DELETE FROM oauth_attempts WHERE binding_hash=?').bind(await digest(flow)));
    if(statements.length)await env.DB.batch(statements);
    const headers=new Headers(privateHeaders);
    headers.append('Set-Cookie',cookie(sessionName,'',0));headers.append('Set-Cookie',cookie(flowName,'',0));
    return Response.json({ok:true},{headers});
  }
  if(path==='/private/auth/google/start' && request.method==='POST' && !url.search){
    if(!originOK(request,env))return json({error:'Forbidden'},403);
    if(!googleReady(env))return json({error:'Login unavailable'},503);
    const state=random(),nonce=random(),binding=random();
    const old=cookieValue(request,flowName);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM oauth_attempts WHERE expires<=? OR binding_hash=?').bind(now,old?await digest(old):''),
      env.DB.prepare('INSERT INTO oauth_attempts(state_hash,binding_hash,nonce_hash,client_id,expires) VALUES(?,?,?,?,?)')
        .bind(await digest(state),await digest(binding),await digest(nonce),env.GOOGLE_CLIENT_ID,now+600),
    ]);
    const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(binding)))))
      .replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const authorization=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorization.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,response_type:'code',scope:'openid email',
      redirect_uri:env.APP_ORIGIN+'/private/auth/google/callback',state,nonce,code_challenge:challenge,
      code_challenge_method:'S256',prompt:'select_account'}).toString();
    return json({authorizationUrl:authorization.toString()},200,{'Set-Cookie':cookie(flowName,binding,600)});
  }
  if(path==='/private/auth/google/callback' && request.method==='GET'){
    if(!googleReady(env) || url.origin!==env.APP_ORIGIN)return finish('unavailable');
    const state=url.searchParams.get('state'),binding=cookieValue(request,flowName);
    if(url.href.length>8192 || !/^[a-f0-9]{64}$/.test(state??'') || !binding ||
      ['state','code','error'].some(key=>url.searchParams.getAll(key).length>1))return finish('expired');
    // Atomic consume prevents callback replay, including simultaneous requests.
    const attempt=await env.DB.prepare(`DELETE FROM oauth_attempts WHERE state_hash=? AND binding_hash=? AND expires>? AND client_id=?
      RETURNING nonce_hash`).bind(await digest(state),await digest(binding),now,env.GOOGLE_CLIENT_ID).first();
    if(!attempt)return finish('expired');
    if(url.searchParams.has('error'))return finish('cancelled');
    const code=url.searchParams.get('code');if(!code || code.length>4096)return finish('failed');
    let identity;
    try{
      // Workers supports manual/follow only. Reject non-2xx below without forwarding credentials to redirects.
      const response=await fetchToken('https://oauth2.googleapis.com/token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),
        headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,
          client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:env.APP_ORIGIN+'/private/auth/google/callback',
          grant_type:'authorization_code',code,code_verifier:binding})});
      const result=await limitedJSON(response);
      identity=await googleIdentity(result.id_token,env,attempt.nonce_hash,now,resolveKey);
    }catch{return finish('failed');}
    // An allowed email bootstraps one subject binding. Later logins use Google's
    // stable subject; another Google account cannot take over a bound email.
    const account=await env.DB.prepare(`UPDATE rp_accounts SET google_sub=COALESCE(google_sub,?),last_login=?
      WHERE disabled=0 AND role='admin' AND (google_sub=? OR (google_sub IS NULL AND email=?)) RETURNING id`)
      .bind(identity.sub,now,identity.sub,identity.email).first();
    if(!account)return finish('denied');
    const token=random(),old=cookieValue(request,sessionName);
    const statements=[env.DB.prepare(`INSERT INTO rp_sessions(hash,account_id,expires)
      SELECT ?,id,? FROM rp_accounts WHERE id=? AND disabled=0 AND role='admin'`).bind(await digest(token),now+8*3600,account.id)];
    if(old)statements.unshift(env.DB.prepare('DELETE FROM rp_sessions WHERE hash=?').bind(await digest(old)));
    await env.DB.batch(statements);
    return finish(null,token);
  }
  return null;
}
