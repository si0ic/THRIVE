import { requireAdmin } from "../_lib/auth.js";
import { listUsers } from "../_lib/alerts.js";
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed." });
  if (!requireAdmin(req, res)) return;
  try { return res.status(200).json({ ok: true, users: await listUsers() }); }
  catch (error) { console.error("[admin/users]", error.message); return res.status(503).json({ ok: false, error: error.message }); }
}
