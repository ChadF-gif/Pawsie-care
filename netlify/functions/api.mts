import type { Config, Context } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { db, json, validHid, readPlan, mutatePlan, emptyPlan, planKey, subsKey, getSubs, notify, checkinLevel, vapidPublic, smsEnabled } from "../lib/core.mts";

const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

function cleanMed(m: any) {
  return {
    id: clip(m.id, 40), name: clip(m.name, 80), strength: clip(m.strength, 60), dose: clip(m.dose, 80),
    every: Number(m.every) > 0 ? Number(m.every) : null, days: Number(m.days) > 0 ? Number(m.days) : null,
    food: !!m.food, asNeeded: !!m.asNeeded, purpose: clip(m.purpose, 80),
    first: clip(m.first, 24), firstTs: Number(m.firstTs) || 0, dueNext: clip(m.dueNext, 24), dueTs: Number(m.dueTs) || 0,
    seen: Array.isArray(m.seen) ? m.seen.slice(0, 3).map((x: any) => clip(x, 12)) : [], note: clip(m.note, 400), confirmed: !!m.confirmed,
    src: isObj(m.src) ? m.src : null,
  };
}

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "");

  if (route === "config") return json({ vapid: vapidPublic(), sms: smsEnabled() });

  if (route === "household" && req.method === "POST") {
    const h = randomBytes(24).toString("base64url");
    const p = emptyPlan();
    await db().setJSON(planKey(h), p);
    return json({ h });
  }

  const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const h = req.method === "GET" ? url.searchParams.get("h") : body.h;
  if (!validHid(h)) return json({ error: "bad household" }, 400);
  const plan = await readPlan(h);
  if (!plan) return json({ error: "unknown household" }, 404);

  if (route === "plan" && req.method === "GET") {
    const since = Number(url.searchParams.get("rev") || -1);
    if (since === plan.rev) return json({ same: true, rev: plan.rev });
    return json({ plan, subs: (await getSubs(h)).length });
  }

  if (route === "subscribe") {
    const sub = body.sub;
    if (!isObj(sub) || typeof sub.endpoint !== "string" || !isObj(sub.keys)) return json({ error: "bad subscription" }, 400);
    const subs = (await getSubs(h)).filter((s) => s.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: sub.keys, ua: clip(body.ua, 120), addedAt: Date.now() });
    await db().setJSON(subsKey(h), subs.slice(-12));
    return json({ ok: true, devices: Math.min(subs.length, 12) });
  }
  if (route === "unsubscribe") {
    const subs = (await getSubs(h)).filter((s) => s.endpoint !== body.endpoint);
    await db().setJSON(subsKey(h), subs);
    return json({ ok: true, devices: subs.length });
  }

  if (route === "test") {
    const r = await notify(h, { title: `${plan.patient || "Pawsie"}: alerts are working`, body: "You'll get a message like this when a dose is due.", tag: "test" }, { endpoint: body.endpoint, plan, sms: false });
    return json(r);
  }

  if (route === "op") {
    const op = body.op;
    if (!isObj(op)) return json({ error: "bad op" }, 400);
    let alertAfter: any = null;
    const out = await mutatePlan(h, (p) => {
      switch (op.t) {
        case "setPlan": {
          const n = op.plan || {};
          const keep = !!n.planId && n.planId === p.planId;
          const track = keep ? { given: p.given, skipped: p.skipped, prn: p.prn, rulesDone: p.rulesDone, checkins: p.checkins, questions: p.questions } : { given: {}, skipped: {}, prn: {}, rulesDone: {}, checkins: [], questions: "" };
          Object.assign(p, {
            planId: clip(n.planId, 40) || randomBytes(8).toString("hex"), patient: clip(n.patient, 60), summary: clip(n.summary, 300),
            clinicName: clip(n.clinicName, 120), clinicPhone: clip(n.clinicPhone, 40), recheck: clip(n.recheck, 400),
            meds: (Array.isArray(n.meds) ? n.meds : []).slice(0, 20).map(cleanMed),
            rules: (Array.isArray(n.rules) ? n.rules : []).slice(0, 30).map((x: any) => clip(x, 300)),
            warnings: (Array.isArray(n.warnings) ? n.warnings : []).slice(0, 30).map((x: any) => clip(x, 300)),
            ...track,
          });
          if (op.tz) p.tz = clip(op.tz, 60);
          break;
        }
        case "given": op.ts ? (p.given[clip(op.id, 60)] = Number(op.ts)) : delete p.given[clip(op.id, 60)]; break;
        case "skip": op.ts ? (p.skipped[clip(op.id, 60)] = Number(op.ts)) : delete p.skipped[clip(op.id, 60)]; break;
        case "prn": {
          const k = clip(op.medId, 60), arr: number[] = (p.prn[k] = p.prn[k] || []);
          if (op.add) { if (!arr.includes(Number(op.add))) arr.push(Number(op.add)); arr.sort((a, b) => a - b); }
          if (op.remove) p.prn[k] = arr.filter((t) => t !== Number(op.remove));
          break;
        }
        case "rule": op.ts ? (p.rulesDone[clip(op.key, 40)] = Number(op.ts)) : delete p.rulesDone[clip(op.key, 40)]; break;
        case "questions": p.questions = clip(op.v, 2000); break;
        case "profile": if (op.tz) p.tz = clip(op.tz, 60); if (typeof op.phone === "string") p.phone = clip(op.phone, 20).replace(/[^0-9+]/g, ""); break;
        case "checkin": {
          const e = op.entry || {}, a = isObj(e.a) ? e.a : {};
          const clean: Record<string, string> = {};
          for (const k of ["eat", "water", "energy", "vomit", "stool", "pain", "cut"]) if (typeof a[k] === "string") clean[k] = clip(a[k], 8);
          const entry = { t: Number(e.t) || Date.now(), a: clean, note: clip(e.note, 500) };
          if (!p.checkins.some((c: any) => c.t === entry.t)) p.checkins.push(entry);
          p.checkins = p.checkins.slice(-60);
          if (checkinLevel(clean) === 2) alertAfter = entry;
          break;
        }
        case "clear": Object.assign(p, emptyPlan(), { rev: p.rev, tz: p.tz, phone: p.phone }); break;
        default: break;
      }
    });
    if (!out) return json({ error: "unknown household" }, 404);
    if (alertAfter) {
      // Warning-sign check-in: tell every phone in the house right away.
      const tel = out.clinicPhone ? "tel:" + out.clinicPhone.replace(/[^0-9+]/g, "") : "";
      await notify(h, {
        title: `${out.patient || "Your pet"}: call ${out.clinicName || "the clinic"} now`,
        body: "A check-in matched a warning sign. Open Pawsie for what was reported.", tag: "red", urgent: true, tel, url: "/",
      }, { plan: out });
    }
    return json({ plan: out });
  }

  return json({ error: "not found" }, 404);
};

export const config: Config = { path: ["/api/config", "/api/household", "/api/plan", "/api/subscribe", "/api/unsubscribe", "/api/test", "/api/op"] };
