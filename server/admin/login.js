import { adminPasswordMatches, setAdminCookie } from "../_lib/auth.js";
import { clientIp, rateLimit } from "../_lib/rate-limit.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed." });
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ ok: false, error: "Invalid JSON body." }); }
  }
  if (!rateLimit(`login:${clientIp(req)}`, 5, 5 * 60 * 1000)) return res.status(429).json({ ok: false, error: "Too many sign-in attempts. Please wait five minutes." });
  if (!adminPasswordMatches(body?.password)) return res.status(401).json({ ok: false, error: "Invalid administrator password." });
  setAdminCookie(res);
  return res.status(200).json({ ok: true });
}
