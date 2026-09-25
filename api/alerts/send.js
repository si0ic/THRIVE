import { requireAdmin } from "../_lib/auth.js";
import { createAlert } from "../_lib/alerts.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed." });
  if (!requireAdmin(req, res)) return;
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ ok: false, error: "Invalid JSON body." }); } }
  try { return res.status(200).json({ ok: true, ...(await createAlert(body || {}, req)) }); }
  catch (error) { console.error("[alerts/send]", error.message); return res.status(400).json({ ok: false, error: error.message }); }
}
