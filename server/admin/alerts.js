import { requireAdmin } from "../_lib/auth.js";
import { selectRows } from "../_lib/db.js";
import { alertWithLogs } from "../_lib/alerts.js";
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed." });
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.query?.id || "").trim();
    if (id) {
      const detail = await alertWithLogs(id);
      if (!detail) return res.status(404).json({ ok: false, error: "Alert not found." });
      return res.status(200).json({ ok: true, ...detail });
    }
    const alerts = await selectRows("weather_alerts", { select: "*", order: "created_at.desc", limit: String(Math.min(Number(req.query?.limit || 20), 100)) });
    return res.status(200).json({ ok: true, alerts });
  } catch (error) { console.error("[admin/alerts]", error.message); return res.status(503).json({ ok: false, error: error.message }); }
}
