import type { Config } from "@netlify/functions";
import { db, readPlan, getSubs, notify, doses, sentKey } from "../lib/core.mts";

const WINDOW = 90 * 60000; // never send an alert more than 90 minutes late

function localParts(ts: number, tz: string) {
  try {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
    const p: Record<string, string> = {};
    for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
  } catch { return { date: new Date(ts).toISOString().slice(0, 10), hour: new Date(ts).getUTCHours() }; }
}

export default async () => {
  const store = db();
  const now = Date.now();
  const { directories } = await store.list({ directories: true, prefix: "h/" });
  let sent = 0, households = 0;

  for (const dir of directories) {
    const h = dir.replace(/^h\//, "").replace(/\/$/, "");
    try {
      const plan = await readPlan(h);
      if (!plan || !plan.meds?.length) continue;
      const hasPush = (await getSubs(h)).length > 0;
      if (!hasPush && !plan.phone) continue;
      households++;
      const who = plan.patient || "Your pet";
      const events: { key: string; at: number; title: string; body: string; doseId?: string; urgent?: boolean }[] = [];

      for (const d of doses(plan)) {
        if (plan.given[d.id] || plan.skipped[d.id]) continue;
        const detail = `${d.med.dose}${d.med.food ? " · give with food" : ""}`;
        events.push({ key: `d:${plan.planId}:${d.id}`, at: d.at, title: `${who}: ${d.med.name} is due now`, body: detail, doseId: d.id, urgent: true });
        events.push({ key: `m:${plan.planId}:${d.id}`, at: d.at + 30 * 60000, title: `${who}: ${d.med.name} still not marked`, body: `${detail}. Mark it given or skip it.`, doseId: d.id });
      }
      for (const m of plan.meds) {
        if (m.asNeeded && m.dueTs) {
          const logged = (plan.prn[m.id] || []).some((t: number) => t >= m.dueTs - 3 * 3600000);
          if (!logged) events.push({ key: `p:${plan.planId}:${m.id}`, at: m.dueTs, title: `${who}: ${m.name} may be due`, body: `${m.dose}. Your paperwork lists this time. Give only if needed.` });
        }
      }
      const lp = localParts(now, plan.tz || "America/New_York");
      if (lp.hour >= 20 && lp.hour < 22) {
        const did = (plan.checkins || []).some((c: any) => localParts(c.t, plan.tz).date === lp.date);
        if (!did) events.push({ key: `c:${plan.planId}:${lp.date}`, at: now, title: `${who}: time for today's check-in`, body: "Twenty seconds. Tap how they're doing." });
      }

      for (const ev of events) {
        if (ev.at > now || now - ev.at > WINDOW) continue;
        const marker = await store.set(sentKey(h, ev.key), String(now), { onlyIfNew: true });
        if (!marker.modified) continue; // already sent
        const r = await notify(h, { title: ev.title, body: ev.body, tag: ev.key, doseId: ev.doseId, urgent: ev.urgent, url: "/" }, { plan });
        sent += r.sent + (r.sms ? 1 : 0);
      }
    } catch (e) {
      console.error("household failed", h, e);
    }
  }
  console.log(JSON.stringify({ households, sent, at: new Date(now).toISOString() }));
};

export const config: Config = { schedule: "* * * * *" };
