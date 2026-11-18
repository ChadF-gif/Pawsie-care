import { getStore } from "@netlify/blobs";
import webpush from "web-push";

export const db = () => getStore({ name: "pawsie", consistency: "strong" });

export const HID = /^[A-Za-z0-9_-]{20,48}$/;
export const validHid = (h: unknown): h is string => typeof h === "string" && HID.test(h);

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/* ---------- check-in severity (kept identical to the app) ---------- */
const sev = (k: string, v: string) => {
  if (!v || v === "ok" || (k === "stool" && v === "none")) return 0;
  if (v === "low") return 1;
  if (v === "bad" || (k === "eat" && v === "none")) return 2;
  return 0;
};
export const checkinLevel = (a: Record<string, string>) =>
  Math.max(0, ...["eat", "water", "energy", "vomit", "stool", "pain", "cut"].map((k) => sev(k, a?.[k])));

/* ---------- plan documents ---------- */
export type Plan = any;
export const emptyPlan = (): Plan => ({
  rev: 0, planId: "", patient: "", summary: "", clinicName: "", clinicPhone: "", meds: [], rules: [], warnings: [], recheck: "", plain: null,
  given: {}, skipped: {}, prn: {}, rulesDone: {}, checkins: [], questions: "", tz: "America/New_York", phone: "", updatedAt: 0,
});

export const planKey = (h: string) => `h/${h}/plan`;
export const subsKey = (h: string) => `h/${h}/subs`;
export const sentKey = (h: string, k: string) => `h/${h}/sent/${k}`;

export async function readPlan(h: string): Promise<Plan | null> {
  return (await db().get(planKey(h), { type: "json" })) as Plan | null;
}

/** Read-modify-write with an ETag check so two phones editing at once don't overwrite each other. */
export async function mutatePlan(h: string, fn: (p: Plan) => void | Plan): Promise<Plan | null> {
  const store = db();
  for (let i = 0; i < 6; i++) {
    const cur = await store.getWithMetadata(planKey(h), { type: "json" });
    if (!cur) return null;
    const plan = cur.data as Plan;
    const out = fn(plan) || plan;
    out.rev = (plan.rev || 0) + 1;
    out.updatedAt = Date.now();
    const res = await store.setJSON(planKey(h), out, { onlyIfMatch: cur.etag });
    if (res.modified) return out;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 80));
  }
  throw new Error("busy");
}

/* ---------- doses (same rules as the app) ---------- */
export const medDays = (m: any) => (m.days > 0 ? m.days : 14);
export function doses(plan: Plan) {
  const out: { id: string; med: any; at: number }[] = [];
  for (const m of plan.meds || []) {
    if (m.asNeeded || !(m.every > 0) || !m.firstTs) continue;
    const n = Math.floor((medDays(m) * 24) / m.every);
    for (let i = 0; i < n; i++) out.push({ id: `${m.id}-${i}`, med: m, at: m.firstTs + i * m.every * 3600000 });
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ---------- notifications ---------- */
let vapidReady = false;
function vapid() {
  if (vapidReady) return true;
  const pub = Netlify.env.get("VAPID_PUBLIC_KEY"), priv = Netlify.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return false;
  webpush.setVapidDetails(Netlify.env.get("VAPID_SUBJECT") || "https://pawsie-app.netlify.app", pub, priv);
  vapidReady = true;
  return true;
}
export const vapidPublic = () => Netlify.env.get("VAPID_PUBLIC_KEY") || "";
export const smsEnabled = () => !!(Netlify.env.get("TWILIO_ACCOUNT_SID") && Netlify.env.get("TWILIO_AUTH_TOKEN") && Netlify.env.get("TWILIO_FROM"));

export async function getSubs(h: string): Promise<any[]> {
  return ((await db().get(subsKey(h), { type: "json" })) as any[] | null) || [];
}

export type Alert = { title: string; body: string; tag?: string; url?: string; doseId?: string; tel?: string; urgent?: boolean };

export async function sendSms(to: string, text: string) {
  const sid = Netlify.env.get("TWILIO_ACCOUNT_SID"), tok = Netlify.env.get("TWILIO_AUTH_TOKEN"), from = Netlify.env.get("TWILIO_FROM");
  if (!sid || !tok || !from) return false;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${sid}:${tok}`), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: text }),
  });
  return r.ok;
}

/** Push to every device in the household (optionally a single endpoint) and text the saved number if SMS is set up. */
export async function notify(h: string, alert: Alert, opts: { endpoint?: string; plan?: Plan; sms?: boolean } = {}) {
  const result = { sent: 0, failed: 0, removed: 0, sms: false, errors: [] as string[] };
  if (vapid()) {
    const subs = await getSubs(h);
    const keep: any[] = [];
    const payload = JSON.stringify({ ...alert, h });
    await Promise.all(
      subs.map(async (s) => {
        if (opts.endpoint && s.endpoint !== opts.endpoint) { keep.push(s); return; }
        try {
          await webpush.sendNotification(s, payload, { TTL: 3600, urgency: alert.urgent ? "high" : "normal" });
          result.sent++; keep.push(s);
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) result.removed++;
          else { result.failed++; keep.push(s); result.errors.push(String(e?.statusCode || e?.message || e).slice(0, 80)); }
        }
      }),
    );
    if (result.removed) await db().setJSON(subsKey(h), keep);
  } else result.errors.push("push keys missing");
  const plan = opts.plan || (await readPlan(h));
  if ((opts.sms ?? true) && plan?.phone && smsEnabled()) result.sms = await sendSms(plan.phone, `Pawsie: ${alert.title}. ${alert.body}`);
  return result;
}
