import crypto from "node:crypto";
import { insertRows, selectRows, updateRows } from "./_lib/db.js";

function send(res, status, body) { return res.status(status).json(body); }
function clean(value, max = 500) { return typeof value === "string" ? value.replace(/[<>]/g, "").trim().slice(0, max) : ""; }
function validPhone(value) { const phone = clean(value, 40).replace(/[()\s-]/g, ""); return /^\+[1-9]\d{7,14}$/.test(phone); }

async function persistUser(record) {
  const existing = await selectRows("users", { select: "id", phone_number: `eq.${record.phone_number}`, limit: "1" });
  const now = new Date().toISOString();
  if (existing.length) {
    const updated = await updateRows("users", { id: existing[0].id }, { ...record, updated_at: now });
    return { id: existing[0].id, created: false, row: updated?.[0] };
  }
  const created = await insertRows("users", [{ id: crypto.randomUUID(), ...record, created_at: now, updated_at: now }]);
  return { id: created[0].id, created: true, row: created[0] };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed." });
  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload || "{}"); } catch { return send(res, 400, { ok: false, error: "Invalid JSON body." }); }
  }
  payload = payload || {};

  const name = clean(payload?.name, 120);
  const email = clean(payload?.email, 254).toLowerCase();
  const phone = clean(payload?.phone, 40).replace(/[()\s-]/g, "");
  const location = payload?.location || {};
  const consent = payload?.consent === true;
  const channels = payload?.channels || {};
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);

  if (!name || !email || !phone) return send(res, 400, { ok: false, error: "Name, email and phone are required." });
  if (!consent) return send(res, 400, { ok: false, error: "Consent to the Privacy Policy is required." });
  if (!validPhone(phone)) return send(res, 400, { ok: false, error: "Use an international phone number, for example +91XXXXXXXXXX." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { ok: false, error: "Email address looks invalid." });
  if (!Number.isFinite(latitude) || latitude < -90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return send(res, 400, { ok: false, error: "Choose a valid location before registering." });

  const record = {
    name,
    email,
    phone_number: phone,
    location_label: clean(location.label || `${location.name || ""}, ${location.admin1 || ""}, ${location.country || ""}`, 240),
    latitude,
    longitude,
    alert_enabled: channels.alerts !== false,
    sms_enabled: channels.sms !== false,
    call_enabled: channels.call === true,
    consent: true,
    consent_at: new Date().toISOString(),
    current_risk_level: ["LOW", "WATCH", "HIGH", "EXTREME"].includes(String(payload?.risk?.level || "")) ? String(payload.risk.level) : null,
    current_risk_score: Number.isFinite(Number(payload?.risk?.score)) ? Math.round(Number(payload.risk.score)) : null
  };

  if (!record.location_label) return send(res, 400, { ok: false, error: "Choose a valid location before registering." });

  try {
    const stored = await persistUser(record);
    const webhook = String(process.env.REGISTRATION_WEBHOOK_URL || "").trim();
    if (webhook) {
      try {
        await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ id: stored.id, ...record, createdAt: new Date().toISOString() }) });
      } catch (error) { console.error("[register] registration webhook failed:", error.message); }
    }
    return send(res, 200, {
      ok: true,
      userId: stored.id,
      created: stored.created,
      notifications: { sms: record.sms_enabled ? "registered" : "disabled", call: record.call_enabled ? "registered" : "disabled" },
      persistence: "supabase"
    });
  } catch (error) {
    console.error("[register]", error.message);
    return send(res, 503, { ok: false, error: error.message || "Registration storage is not configured." });
  }
}
