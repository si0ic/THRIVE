import { requireAdmin } from "../_lib/auth.js";
import { isDatabaseConfigured } from "../_lib/db.js";
import { env } from "../_lib/config.js";
import { messageConfigReady, voiceConfigReady } from "../_lib/alerts.js";

function truthy(name) {
  return /^(true|1|yes)$/i.test(env(name));
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed." });
  if (!requireAdmin(req, res)) return;
  const smsReady = Boolean(
    messageConfigReady() &&
    env("EXOTEL_SMS_SENDER_ID") &&
    env("EXOTEL_DLT_ENTITY_ID") &&
    env("EXOTEL_DLT_TEMPLATE_ID") &&
    env("EXOTEL_SMS_TEMPLATE")
  );
  const voiceReady = Boolean(voiceConfigReady());
  return res.status(200).json({
    ok: true,
    checks: {
      database: isDatabaseConfigured(),
      adminSession: Boolean(env("ADMIN_PASSWORD") && env("SESSION_SECRET")),
      sms: smsReady,
      voice: voiceReady,
      webhookSecret: Boolean(env("EXOTEL_WEBHOOK_SECRET")),
      appBaseUrl: Boolean(env("APP_BASE_URL")),
      cronSecret: Boolean(env("CRON_SECRET")),
      testMode: truthy("ALERT_TEST_MODE_ENABLED"),
      testNumber: Boolean(env("ALERT_TEST_NUMBER"))
    }
  });
}
