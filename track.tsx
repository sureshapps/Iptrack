// Supabase Edge Function "track" — deploy with "Verify JWT" turned OFF (pixels and visitors are anonymous).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const maskIP = (ip: string) => ip.includes(":") ? ip.split(":").slice(0, 3).join(":") + ":…" : ip.split(".").slice(0, 3).join(".") + ".x";
const clientIP = (r: Request) => (r.headers.get("cf-connecting-ip") || r.headers.get("x-forwarded-for") || "").split(",")[0].trim();
const validRef = (r?: string) => { try { return r ? new URL(r).href : null; } catch { return null; } };
const isActive = (l: any) => l && l.status === "active" && !(l.expires_at && new Date(l.expires_at) < new Date());

function parseUA(ua: string) {
  let browser = "Other", os = "Other", device = "desktop";
  if (/Edg\//.test(ua)) browser = "Edge"; else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua)) browser = "Chrome"; else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = "Safari";
  if (/Windows NT/.test(ua)) os = "Windows"; else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS"; else if (/Mac OS X/.test(ua)) os = "macOS"; else if (/Linux/.test(ua)) os = "Linux";
  if (/iPad|Tablet/.test(ua)) device = "tablet"; else if (/Mobile|iPhone|Android/.test(ua)) device = "mobile";
  if (/bot|crawl|spider|slurp|preview/i.test(ua)) { device = "bot"; browser = "Bot/Crawler"; }
  return { browser, os, device };
}

async function record(req: Request, l: any, type: string, ref?: string, utm: any = {}) {
  const ip = clientIP(req), agent = req.headers.get("user-agent") || "";
  let g: any = {};
  try { // best-effort IP → approximate location (swap for any provider you prefer)
    if (ip) { const j = await (await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(2500) })).json(); if (j.success) g = j; }
  } catch { /* ignore */ }
  const p = parseUA(agent);
  await sb.from("tracking_events").insert({
    link_id: l.id, event_type: type, ip_masked: ip ? maskIP(ip) : null,
    visitor_token: (await sha(ip + agent + new Date().toISOString().slice(0, 10))).slice(0, 16),
    country: g.country ?? "Unknown", country_code: g.country_code ?? "—", region: g.region ?? "—", city: g.city ?? "Unknown",
    lat: g.latitude ?? null, lng: g.longitude ?? null,
    browser: p.browser, operating_system: p.os, device_type: p.device,
    referrer: validRef(ref ?? req.headers.get("referer") ?? undefined),
    language: (req.headers.get("accept-language") || "unknown").split(",")[0],
    utm_source: utm.utm_source ?? null, utm_medium: utm.utm_medium ?? null, utm_campaign: utm.utm_campaign ?? null,
  });
}

async function view(l: any) {
  const { data: o } = await sb.from("profiles").select("display_name").eq("id", l.owner_id).maybeSingle();
  return { id: l.id, title: l.title, destinationUrl: l.destination_url, purpose: l.purpose, retentionDays: l.retention_days,
    status: l.status, expiresAt: l.expires_at ? Date.parse(l.expires_at) : null, ownerName: o?.display_name ?? null, linkType: l.link_type };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  if (req.method === "GET") { // tracking pixel: ?p=<slug>
    const slug = new URL(req.url).searchParams.get("p");
    if (slug) {
      const { data: l } = await sb.from("tracking_links").select("*").eq("slug", slug).eq("link_type", "pixel").maybeSingle();
      if (isActive(l)) await record(req, l, "pixel_load");
    }
    return new Response(PNG, { headers: { ...cors, "Content-Type": "image/png", "Cache-Control": "no-store, max-age=0" } });
  }

  const b = await req.json().catch(() => ({}));

  if (b.action === "visit") {
    const { data: l } = await sb.from("tracking_links").select("*").eq("slug", String(b.slug)).eq("link_type", b.linkType).maybeSingle();
    if (!l) return json({ link: null });
    if (isActive(l)) await record(req, l, "visit", b.ref, b.utm || {});
    return json({ link: await view(l) });
  }

  if (b.action === "link_info") {
    const { data: l } = await sb.from("tracking_links").select("*").eq("id", String(b.id)).maybeSingle();
    return json({ link: l ? await view(l) : null });
  }

  if (b.action === "geo") {
    const { data: l } = await sb.from("tracking_links").select("*").eq("id", String(b.linkId)).eq("link_type", "geolocation").maybeSingle();
    const la = Number(b.latitude), lo = Number(b.longitude);
    if (!isActive(l) || !(Math.abs(la) <= 90) || !(Math.abs(lo) <= 180)) return json({ error: "Link unavailable or invalid location." }, 400);
    const { data: c, error } = await sb.from("geolocation_consents").insert({
      tracking_link_id: l.id, consent_token_hash: await sha(crypto.randomUUID()), purpose: l.purpose,
      expires_at: new Date(Date.now() + l.retention_days * 864e5).toISOString(),
    }).select("id").single();
    if (error) return json({ error: "Could not record consent." }, 500);
    await sb.from("geolocation_events").insert({ tracking_link_id: l.id, consent_id: c.id, latitude: la, longitude: lo, accuracy_meters: Math.round(Number(b.accuracy) || 0) });
    return json({ ok: true });
  }

  if (b.action === "report") {
    const reasons = ["phishing", "malware", "spam", "impersonation", "harassment", "other suspicious activity"];
    const d = String(b.description || "").trim();
    if (!reasons.includes(b.reason) || d.length < 10 || d.length > 1000) return json({ error: "Invalid report." }, 400);
    const { data: l } = await sb.from("tracking_links").select("id").eq("id", String(b.linkId)).maybeSingle();
    if (!l) return json({ error: "Link not found." }, 404);
    const who = (await sha("rep" + clientIP(req))).slice(0, 16);
    const { count } = await sb.from("tracking_reports").select("id", { count: "exact", head: true })
      .eq("reporter_reference", who).gte("created_at", new Date(Date.now() - 60000).toISOString());
    if (count) return json({ error: "Please wait a minute before submitting another report." }, 429);
    await sb.from("tracking_reports").insert({ tracking_link_id: l.id, reporter_reference: who, reason: b.reason, description: d });
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
