import type { Config } from "@netlify/functions";
import Anthropic from "@anthropic-ai/sdk";
import { json, validHid, readPlan } from "../lib/core.mts";

const PROMPT =
  "You are reading photos of a veterinary discharge sheet and prescription bottle labels. Transcribe only what is printed or handwritten. Never guess or fill gaps from general knowledge. " +
  'Return JSON only, no prose, in this shape: {"patient":string|null,"summary":string|null,"clinic":string|null,"clinic_phone":string|null,' +
  '"meds":[{"name":string,"strength":string|null,"with_food":boolean,"as_needed":boolean,"purpose":string|null,' +
  '"sheet":{"dose":string|null,"every_hours":number|null,"days":number|null}|null,"bottle":{"dose":string|null,"every_hours":number|null,"days":number|null}|null,' +
  '"due_next":{"month":number,"day":number,"hour24":number,"minute":number}|null,"note":string|null}],' +
  '"care_rules":[string],"warning_signs":[string],"recheck":string|null,"plain":{"short":string,"points":[string],"terms":[{"term":string,"meaning":string}]}|null}. ' +
  "summary: one short line on what the visit or procedure was, as printed. every_hours: if a range such as 8-12 hours is given, use the smaller number. days: the stated length, or null. " +
  "sheet: what the discharge sheet says for this medication, or null if it is not on the sheet. bottle: what its bottle label says, or null if no bottle photo. Do not compare or merge them; copy each source separately. " +
  "due_next: if a date and time is handwritten or printed next to this medication as when it is due next (for example due next 11/17 @ 8pm), give it in 24-hour form; otherwise null. " +
  "as_needed: true only if the paper says as needed or PRN. If the paper gives no number of days for a medication, days is null. " +
  "purpose: plain words such as pain medicine or nausea medicine, only if printed or stated on the sheet. note: only if something is hard to read, else null. " +
  "clinic_phone: the clinic's phone number if printed anywhere (letterhead counts). " +
  "care_rules: each instruction the owner must follow at home (activity, collar, bathing, diet, wound care) as one short sentence, only what is printed. " +
  "warning_signs: signs the paper says to call about or stop a medicine for, only what is printed. recheck: the follow-up visit instruction as printed, including the timeframe. " +
  "plain: explain the vet's notes (diagnosis, findings, procedure, treatment, anything clinical on the paperwork) in the simplest everyday words, as if to a worried friend with no medical background (about a 6th-grade reading level, short sentences, no jargon). " +
  "short: 2 to 3 sentences on what happened and where things stand. points: up to 8 short bullets, each starting with a plain label such as What happened, What they found, What they did, or What it means, covering only what the notes say. " +
  "terms: each medical word or abbreviation printed on the paperwork (for example GDV, gastropexy, ASA) with a one-line plain meaning, max 10. " +
  "Rules for plain: explain only what is written on the paperwork. Do not add a diagnosis, prognosis, cause, risk, or advice that is not printed. If the notes do not say something, leave it out. Do not tell the owner to change any dose. If there are no clinical notes on the paperwork, set plain to null.";

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const body: any = await req.json().catch(() => ({}));
  if (!validHid(body.h) || !(await readPlan(body.h))) return json({ error: "unknown household" }, 404);
  const images: string[] = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  if (!images.length) return json({ error: "no photos" }, 400);
  const content: any[] = [];
  for (const d of images) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(d));
    if (!m) return json({ error: "bad image" }, 400);
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  content.push({ type: "text", text: PROMPT });
  try {
    const client = new Anthropic();
    const res = await client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 4500, messages: [{ role: "user", content }] });
    const txt = res.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
    const a = txt.indexOf("{"), z = txt.lastIndexOf("}");
    if (a < 0 || z < 0) return json({ error: "unreadable" }, 422);
    return json({ data: JSON.parse(txt.slice(a, z + 1)) });
  } catch (e: any) {
    console.error("read failed", e?.status, e?.message);
    return json({ error: "read failed", detail: String(e?.message || e).slice(0, 200) }, 502);
  }
};

export const config: Config = {
  path: "/api/read",
  rateLimit: { windowLimit: 12, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
