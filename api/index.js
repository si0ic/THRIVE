// Single Vercel Function that routes every /api/* request to its handler in server/.
// Keeps the deployment under the Hobby plan's 12-function limit.
import health from "../server/health.js";
import resources from "../server/resources.js";
import register from "../server/register.js";
import locationAi from "../server/location-ai.js";
import alertsSend from "../server/alerts/send.js";
import alertsSms from "../server/alerts/sms.js";
import alertsCall from "../server/alerts/call.js";
import alertsAutomatic from "../server/alerts/automatic.js";
import adminLogin from "../server/admin/login.js";
import adminLogout from "../server/admin/logout.js";
import adminMe from "../server/admin/me.js";
import adminStatus from "../server/admin/status.js";
import adminUsers from "../server/admin/users.js";
import adminAlerts from "../server/admin/alerts.js";
import exotelCallWebhook from "../server/webhooks/exotel/call.js";
import exotelSmsWebhook from "../server/webhooks/exotel/sms.js";

const ROUTES = new Map([
  ["health", health],
  ["resources", resources],
  ["register", register],
  ["location-ai", locationAi],
  ["alerts/send", alertsSend],
  ["alerts/sms", alertsSms],
  ["alerts/call", alertsCall],
  ["alerts/automatic", alertsAutomatic],
  ["admin/login", adminLogin],
  ["admin/logout", adminLogout],
  ["admin/me", adminMe],
  ["admin/status", adminStatus],
  ["admin/users", adminUsers],
  ["admin/alerts", adminAlerts],
  ["webhooks/exotel/call", exotelCallWebhook],
  ["webhooks/exotel/sms", exotelSmsWebhook],
]);

export default async function handler(req, res) {
  const route = String(req.query?.__path || "").replace(/^\/+|\/+$/g, "");
  delete req.query.__path;
  const target = ROUTES.get(route);
  if (!target) return res.status(404).json({ ok: false, error: "Not found." });
  return target(req, res);
}
