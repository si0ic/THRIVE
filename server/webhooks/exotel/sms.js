import { env } from "../../_lib/config.js";
import { updateProviderStatus, mapSmsStatus } from "../../_lib/alerts.js";
function authorized(req) { const expected = String(env("EXOTEL_WEBHOOK_SECRET") || "").trim(); if (!expected) return false; const given = String(req.query?.token || req.headers?.["x-thrive-webhook-token"] || ""); return given === expected; }
function bodyValue(body, ...keys) { for (const key of keys) if (body?.[key] !== undefined) return body[key]; return ""; }
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed." });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: "Webhook authentication failed." });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { const params = new URLSearchParams(body || ""); body = Object.fromEntries(params.entries()); } }
  const sid = String(bodyValue(body, "SmsSid", "SMSMessageSid", "SmsMessageSid", "MessageSid", "Sid")).trim();
  const status = mapSmsStatus(bodyValue(body, "DetailedStatus", "Status", "status"));
  try { const result = await updateProviderStatus({ providerMessageId: sid, channel: "sms", status, rawPayload: body }); return res.status(200).json({ ok: true, updated: result.updated }); }
  catch (error) { console.error("[webhook/sms]", error.message); return res.status(500).json({ ok: false, error: error.message }); }
}
