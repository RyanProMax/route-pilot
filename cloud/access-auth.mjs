import {createRemoteJWKSet, jwtVerify} from 'jose';

const resolvers = new Map();
export const adminMode = env => env.ADMIN_AUTH_MODE ?? 'key';

// The issuer is deployment configuration, never a URL taken from an unverified JWT.
export async function accessIdentity(request, env, now, resolveKey) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16384 ||
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER ?? '') ||
      !/^[a-f0-9]{64}$/.test(env.ACCESS_AUD ?? '')) return false;
  const allowed = (env.ACCESS_EMAIL_SHA256 ?? '').split(',');
  if (!allowed.length || allowed.length > 20 || allowed.some(x => !/^[a-f0-9]{64}$/.test(x))) return false;
  try {
    let keys = resolveKey ?? resolvers.get(env.ACCESS_ISSUER);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(env.ACCESS_ISSUER + '/cdn-cgi/access/certs'),
        {timeoutDuration:5000, cooldownDuration:30000, cacheMaxAge:600000});
      if (resolvers.size >= 4) resolvers.clear();
      resolvers.set(env.ACCESS_ISSUER, keys);
    }
    const {payload} = await jwtVerify(token, keys, {
      issuer:env.ACCESS_ISSUER, audience:env.ACCESS_AUD, algorithms:['RS256'],
      requiredClaims:['exp','iat','sub','email'], maxTokenAge:'8h', clockTolerance:5,
      currentDate:new Date(now * 1000),
    });
    if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.email !== 'string' || !payload.email) return false;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload.email.toLowerCase())));
    const emailHash = Array.from(hash, x => x.toString(16).padStart(2, '0')).join('');
    return allowed.includes(emailHash);
  } catch {
    // Neither assertions, identity claims nor upstream error bodies belong in logs.
    return false;
  }
}
