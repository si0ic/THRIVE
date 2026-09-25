import { clearAdminCookie, requireAdmin } from "../_lib/auth.js";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed." });
  if (!requireAdmin(req, res)) return;
  clearAdminCookie(res);
  return res.status(200).json({ ok: true });
}
