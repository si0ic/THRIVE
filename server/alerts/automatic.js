import { cronAuthenticated, requireAdmin } from "../_lib/auth.js";
import { eligibleUsers, recentNotificationLogs, createAlert, normalizePhone } from "../_lib/alerts.js";
import { calculateRisk, currentWeather, whyText } from "../_lib/risk.js";
import { env } from "../_lib/config.js";
function isCron(req) { return cronAuthenticated(req); }
function locationKey(user) { return `${Number(user.latitude).toFixed(3)}:${Number(user.longitude).toFixed(3)}`; }
async function execute(req, source) {
  const users = await eligibleUsers();
  const cooldownMinutes = Math.max(1, Number(env("ALERT_COOLDOWN_MINUTES", "180")) || 180);
  const cutoffMs = Date.now() - cooldownMinutes * 60 * 1000;
  const logs = await recentNotificationLogs(new Date(cutoffMs).toISOString());
  const blocked = new Set(logs.map((log) => `${log.user_id}|${log.location_key}|${log.risk_level}`));
  const grouped = new Map();
  for (const user of users) { const key = locationKey(user); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(user); }
  const results = [];
  for (const group of grouped.values()) {
    const sample = group[0];
    const location = { label: sample.location_label, name: sample.location_label, latitude: Number(sample.latitude), longitude: Number(sample.longitude) };
    if (![location.latitude, location.longitude].every(Number.isFinite)) continue;
    try {
      const weather = await currentWeather(location);
      const risk = calculateRisk(weather, location);
      if (!['HIGH', 'EXTREME'].includes(risk.level)) { results.push({ location: location.label, risk: risk.level, skipped: true }); continue; }
      const recipients = group.filter((user) => {
        if (!user.alert_enabled || !user.consent) return false;
        if (!normalizePhone(user.phone_number)) return false;
        if (risk.level === 'HIGH' && !user.sms_enabled) return false;
        if (risk.level === 'EXTREME' && !user.sms_enabled && !user.call_enabled) return false;
        return !blocked.has(`${user.id}|${locationKey(user)}|${risk.level}`);
      });
      if (!recipients.length) { results.push({ location: location.label, risk: risk.level, skipped: true, reason: 'cooldown_or_channel' }); continue; }
      const sendSms = recipients.some((u) => u.sms_enabled);
      const sendCall = risk.level === 'EXTREME' && recipients.some((u) => u.call_enabled);
      const message = `${risk.level === 'EXTREME' ? 'Avoid unnecessary outdoor exposure, move to a cooler place, drink water regularly, and check vulnerable people.' : 'Limit outdoor exposure, take water and shade breaks, and check vulnerable people.'}`;
      const result = await createAlert({ recipientIds: recipients.map((u) => u.id), location: { label: location.label, name: location.label, latitude: location.latitude, longitude: location.longitude }, riskLevel: risk.level, riskScore: risk.score, temperatureC: weather.temperature, message, warningText: whyText(risk), sendSms, sendCall, automatic: true, testMode: env('ALERT_AUTOMATIC_TEST_MODE', 'false').toLowerCase().match(/^(true|1|yes)$/) !== null }, req);
      results.push({ location: location.label, risk: risk.level, alertId: result.alertId, recipients: result.recipients.length });
    } catch (error) { console.error('[alerts/automatic]', location.label, error.message); results.push({ location: location.label, error: error.message }); }
  }
  return { ok: true, source, locationsChecked: grouped.size, results };
}
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  if (isCron(req)) { try { return res.status(200).json(await execute(req, 'vercel-cron')); } catch (error) { console.error('[alerts/automatic]', error.message); return res.status(500).json({ ok: false, error: error.message }); } }
  if (!requireAdmin(req, res)) return;
  try { return res.status(200).json(await execute(req, 'admin-manual-run')); } catch (error) { console.error('[alerts/automatic]', error.message); return res.status(500).json({ ok: false, error: error.message }); }
}
