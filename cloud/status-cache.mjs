import { publicSummaries, publicSummary, windows } from "./public-status.mjs";

const paths = new Map(Object.keys(windows).map(window => ["/status/" + window + ".json", window]));

// Cloudflare checks its tiered cache before invoking this handler. Only these public GETs are cacheable.
export async function readStatus(request, db, now, planGB, instanceId = "node-1") {
  const url = new URL(request.url);
  const prefix = "/status/" + instanceId + "/";
  const path = url.pathname.startsWith(prefix) ? "/status/" + url.pathname.slice(prefix.length) : url.pathname;
  const window = paths.get(path);
  const all = url.pathname === prefix + "all.json";
  if (!window && !all) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {status:405, headers:{Allow:"GET, HEAD","Cache-Control":"no-store"}});
  }
  if (url.search) return new Response(null, {status:400, headers:{"Cache-Control":"no-store"}});

  try {
    const data = all
      ? { instanceId, windows: await publicSummaries(db, Object.keys(windows), now, planGB) }
      : { instanceId, ...await publicSummary(db, window, now, planGB) };
    // Keep the five-check contract for pages loaded before instance-specific routes.
    if (!url.pathname.startsWith(prefix)) data.checks = data.checks.filter(check => check.id !== "connections");
    const body = request.method === "HEAD" ? null : JSON.stringify(data);
    return new Response(body, {headers:{
      "Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"public, max-age=60, s-maxage=60, must-revalidate",
      "X-Content-Type-Options":"nosniff"
    }});
  } catch {
    return Response.json({error:"Status temporarily unavailable"}, {
      status:503, headers:{"Cache-Control":"no-store","Retry-After":"60"}
    });
  }
}
