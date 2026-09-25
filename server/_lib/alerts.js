import crypto from "node:crypto";
import { env, baseUrl } from "./config.js";
import { rateLimit } from "./rate-limit.js";
import { insertRows, selectRows, updateRows } from "./db.js";
import { sendSms, makeCall, extractSmsSid, extractCallSid } from "./exotel.js";

export const SMS_STATUS = {
  REQUEST_ACCEPTED: "REQUEST_ACCEPTED",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  FAILED: "FAILED"
};

export const CALL_STATUS = {
  INITIATED: "INITIATED",
  RINGING: "RINGING",
  ANSWERED: "ANSWERED",
  COMPLETED: "COMPLETED",
  BUSY: "BUSY",
  NO_ANSWER: "NO_ANSWER",
  FAILED: "FAILED"
};

function clean(value, max = 1000) {
  return typeof value === "string" ? value.replace(/[<>]/g, "").trim().slice(0, max) : "";
}

export function normalizePhone(value) {
  const phone = clean(value, 40).replace(/[()\s-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : "";
}

export function normalizeAlert(input) {
  const location = input?.location || {};
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const riskLevel = String(input?.riskLevel || input?.risk?.level || "").toUpperCase();
  const temperatureC = Number(input?.temperatureC ?? input?.temperature ?? NaN);
  const riskScore = Number(input?.riskScore ?? input?.risk?.score ?? NaN);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error("Valid alert coordinates are required.");
  if (!['LOW','WATCH','HIGH','EXTREME'].includes(riskLevel)) throw new Error("Invalid risk level.");
  if (!Number.isFinite(temperatureC)) throw new Error("Valid temperature is required.");
  if (!Number.isFinite(riskScore) || riskScore < 0 || riskScore > 100) throw new Error("Thermal risk score must be between 0 and 100.");
  const label = clean(location.label || `${location.name || ""}, ${location.admin1 || ""}, ${location.country || ""}`, 240).replace(/^,\s*|,\s*$/g, "");
  if (!label) throw new Error("Alert location is required.");
  return {
    label,
    latitude,
    longitude,
    temperatureC,
    riskLevel,
    riskScore: Math.round(riskScore),
    message: clean(input?.message, 1200),
    warningText: clean(input?.warningText || input?.message, 1200),
    automatic: input?.automatic === true,
    testMode: input?.testMode === true
  };
}

function safetyText(alert) {
  return alert.riskLevel === "EXTREME"
    ? "Avoid unnecessary outdoor exposure, move to a cooler place, drink water regularly, and check on vulnerable people."
    : alert.riskLevel === "HIGH"
      ? "Limit outdoor exposure, take regular shade and water breaks, and check on vulnerable people."
      : "Reduce prolonged outdoor exposure and stay hydrated.";
}

function renderTemplate(template, alert, safety) {
  const time = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date());
  const values = {
    location: alert.label,
    temperature: String(Math.round(alert.temperatureC * 10) / 10),
    risk_level: alert.riskLevel,
    risk_score: String(alert.riskScore),
    time,
    safety
  };
  return String(template || "")
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => values[key.toLowerCase()] ?? "")
    .trim();
}

export function buildMessage(alert) {
  const configured = env("EXOTEL_SMS_TEMPLATE");
  if (!configured) throw new Error("DLT template configuration missing: set EXOTEL_SMS_TEMPLATE to the exact approved Exotel/DLT template with {{location}}, {{temperature}}, {{risk_level}}, {{risk_score}}, {{time}} and {{safety}} placeholders.");
  return renderTemplate(configured, alert, alert.warningText || safetyText(alert));
}

export function buildCallMessage(alert) {
  const safety = alert.riskLevel === "EXTREME"
    ? "Avoid unnecessary outdoor exposure, move to a cooler place, drink water regularly, and check vulnerable people."
    : "Limit outdoor exposure, take shade and water breaks, and check vulnerable people.";
  const template = env("EXOTEL_VOICE_SCRIPT", `This is a THRIVE weather alert. Heat risk is {{risk_level}} in your registered area. {{safety}}`);
  return renderTemplate(template, alert, alert.warningText || safety);
}

async function findUsersByIds(ids) {
  const safeIds = [...new Set(ids.filter((id) => /^[0-9a-f-]{20,}$/i.test(String(id))))];
  if (!safeIds.length) return [];
  const or = safeIds.map((id) => `id.eq.${id}`).join(",");
  return selectRows("users", { select: "id,name,email,phone_number,location_label,latitude,longitude,alert_enabled,sms_enabled,call_enabled,consent", or });
}

function webhookUrl(req, channel) {
  const base = baseUrl(req);
  if (!base) return "";
  const token = env("EXOTEL_WEBHOOK_SECRET");
  const path = channel === "sms" ? "/api/webhooks/exotel/sms" : "/api/webhooks/exotel/call";
  return token ? `${base}${path}?token=${encodeURIComponent(token)}` : `${base}${path}`;
}

async function createLog(alertId, recipientId, user, channel, status, error = "", providerMessageId = "", meta = {}) {
  const now = new Date().toISOString();
  const rows = await insertRows("notification_logs", [{
    id: crypto.randomUUID(),
    alert_id: alertId,
    user_id: user.id,
    recipient_id: recipientId,
    phone_number: user.phone_number,
    channel,
    provider: "exotel",
    provider_message_id: providerMessageId || null,
    status,
    error: error ? clean(error, 700) : null,
    location_key: meta.locationKey || null,
    risk_level: meta.riskLevel || null,
    automatic: meta.automatic === true,
    created_at: now,
    updated_at: now
  }]);
  return rows[0];
}

export async function createAlert(input, req) {
  const alert = normalizeAlert(input);
  const users = await findUsersByIds(Array.isArray(input.recipientIds) ? input.recipientIds : []);
  const eligible = users.filter((u) => u.alert_enabled && u.consent && normalizePhone(u.phone_number));
  if (!eligible.length) throw new Error("No eligible opted-in recipients were selected.");
  const requestedSms = input.sendSms === true;
  const requestedCall = input.sendCall === true;
  if (!requestedSms && !requestedCall) throw new Error("Select SMS, voice call, or both.");
  const maxRecipients = Math.max(1, Number(env("ALERT_MAX_RECIPIENTS", "100")) || 100);
  if (eligible.length > maxRecipients) throw new Error(`Recipient limit reached. Maximum ${maxRecipients} recipients per alert.`);
  const rateWindowMinutes = Math.max(1, Number(env("ALERT_RATE_WINDOW_MINUTES", "10")) || 10);
  const rateLimitCount = Math.max(1, Number(env("ALERT_RATE_LIMIT", "10")) || 10);
  if (input.automatic !== true) {
    const rateLimitKey = `alerts:${req?.headers?.["x-forwarded-for"] || req?.headers?.["x-real-ip"] || "server"}`;
    if (!rateLimit(rateLimitKey, rateLimitCount, rateWindowMinutes * 60 * 1000)) throw new Error("Rate limit reached. Please wait before sending another alert.");
  }
  const cutoff = new Date(Date.now() - rateWindowMinutes * 60 * 1000).toISOString();
  const recentAlerts = await selectRows("weather_alerts", { select: "id", created_at: `gte.${cutoff}`, limit: String(rateLimitCount + 1) });
  if (recentAlerts.length >= rateLimitCount) throw new Error("Rate limit reached. Please wait before sending another alert.");
  if (requestedCall && !eligible.some((u) => u.call_enabled)) throw new Error("No selected recipient has voice calls enabled.");
  if (alert.riskLevel !== "EXTREME" && requestedCall && input.automatic === true) throw new Error("Automatic voice calls are limited to EXTREME alerts.");

  const smsBody = requestedSms ? buildMessage(alert) : "";
  const callBody = requestedCall ? buildCallMessage(alert) : "";
  const testMode = input.testMode === true;
  const configuredTestNumber = normalizePhone(env("ALERT_TEST_NUMBER"));
  if (testMode && !configuredTestNumber) throw new Error("TEST MODE requires ALERT_TEST_NUMBER.");
  if (testMode && !env("ALERT_TEST_MODE_ENABLED", "false").toLowerCase().match(/^(true|1|yes)$/)) throw new Error("TEST MODE is disabled by server configuration.");

  const created = (await insertRows("weather_alerts", [{
    id: crypto.randomUUID(),
    location_label: alert.label,
    latitude: alert.latitude,
    longitude: alert.longitude,
    temperature_c: alert.temperatureC,
    risk_level: alert.riskLevel,
    risk_score: alert.riskScore,
    message: smsBody || callBody || alert.warningText || alert.message || "THRIVE heat-health alert",
    automatic: alert.automatic,
    test_mode: testMode,
    created_at: new Date().toISOString()
  }]))[0];

  const recipientRows = eligible.map((user) => ({
    id: crypto.randomUUID(),
    alert_id: created.id,
    user_id: user.id,
    phone_number: user.phone_number,
    sms_status: requestedSms && user.sms_enabled ? "QUEUED" : "NOT_SELECTED",
    call_status: requestedCall && user.call_enabled ? "QUEUED" : "NOT_SELECTED",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }));
  const recipients = await insertRows("alert_recipients", recipientRows);
  const byUser = new Map(recipients.map((r) => [r.user_id, r]));
  const locationKey = `${alert.latitude.toFixed(3)}:${alert.longitude.toFixed(3)}`;
  const results = [];

  for (const user of eligible) {
    const recipient = byUser.get(user.id);
    const phone = testMode ? configuredTestNumber : normalizePhone(user.phone_number);
    if (requestedSms && user.sms_enabled) {
      if (testMode) {
        const log = await createLog(created.id, recipient.id, { ...user, phone_number: phone }, "sms", "TEST_MODE", "", "", { locationKey, riskLevel: alert.riskLevel, automatic: alert.automatic });
        results.push({ userId: user.id, name: user.name, channel: "sms", status: "TEST_MODE", preview: smsBody, logId: log.id });
      } else {
        try {
          const response = await sendSms({ to: phone, body: smsBody, statusCallback: webhookUrl(req, "sms") });
          const sid = extractSmsSid(response);
          const log = await createLog(created.id, recipient.id, { ...user, phone_number: phone }, "sms", SMS_STATUS.REQUEST_ACCEPTED, "", sid, { locationKey, riskLevel: alert.riskLevel, automatic: alert.automatic });
          await updateRows("alert_recipients", { id: recipient.id }, { sms_status: SMS_STATUS.REQUEST_ACCEPTED, updated_at: new Date().toISOString() });
          results.push({ userId: user.id, name: user.name, channel: "sms", status: SMS_STATUS.REQUEST_ACCEPTED, providerMessageId: sid, logId: log.id });
        } catch (error) {
          const log = await createLog(created.id, recipient.id, user, "sms", SMS_STATUS.FAILED, error.message, "", { locationKey, riskLevel: alert.riskLevel, automatic: alert.automatic });
          await updateRows("alert_recipients", { id: recipient.id }, { sms_status: SMS_STATUS.FAILED, updated_at: new Date().toISOString() });
          results.push({ userId: user.id, name: user.name, channel: "sms", status: SMS_STATUS.FAILED, error: error.message, logId: log.id });
        }
      }
    }

    if (requestedCall && user.call_enabled) {
      if (testMode) {
        const log = await createLog(created.id, recipient.id, { ...user, phone_number: phone }, "call", "TEST_MODE", "", "", { locationKey, riskLevel: alert.riskLevel, automatic: alert.automatic });
        results.push({ userId: user.id, name: user.name, channel: "call", status: "TEST_MODE", preview: callBody, logId: log.id });
      } else {
        try {
          const response = await makeCall({ to: phone, statusCallback: webhookUrl(req, "call"), customField: created.id });
          const sid = extractCallSid(response);
          const log = await createLog(created.id, recipient.id, user, "call", CALL_STATUS.INITIATED, "", sid, { locationKey, riskLevel: alert.riskLevel, automatic: alert.automatic });
          await updateRows("alert_recipients", { id: recipient.id }, { call_status: CALL_STATUS.INITIATED, updated_at: new Date().toISOString() });
          results.push({ userId: user.id, name: user.name, channel: "call", status: CALL_STATUS.INITIATED, providerMessageId: sid, logId: log.id });
        } catch (error) {
          const log = await createLog(created.id, recipient.id, user, "call", CALL_STATUS.FAILED, error.message, "", { locationKey, riskLevel: alert.riskLevel, automatic: alert.automatic });
          await updateRows("alert_recipients", { id: recipient.id }, { call_status: CALL_STATUS.FAILED, updated_at: new Date().toISOString() });
          results.push({ userId: user.id, name: user.name, channel: "call", status: CALL_STATUS.FAILED, error: error.message, logId: log.id });
        }
      }
    }
  }

  return { alert, alertId: created.id, recipients: results, smsPreview: smsBody, callPreview: callBody, testMode };
}

export async function eligibleUsers() {
  return selectRows("users", {
    select: "id,name,email,phone_number,location_label,latitude,longitude,alert_enabled,sms_enabled,call_enabled,consent",
    alert_enabled: "eq.true",
    consent: "eq.true",
    order: "created_at.desc"
  });
}

export async function listUsers() {
  return selectRows("users", {
    select: "id,name,email,phone_number,location_label,latitude,longitude,alert_enabled,sms_enabled,call_enabled,consent,created_at,updated_at",
    order: "created_at.desc",
    limit: "500"
  });
}

export async function recentNotificationLogs(cutoffIso) {
  return selectRows("notification_logs", {
    select: "id,user_id,phone_number,channel,status,provider_message_id,location_key,risk_level,automatic,created_at",
    created_at: `gte.${cutoffIso}`,
    order: "created_at.desc",
    limit: "2000"
  });
}

export async function alertWithLogs(alertId) {
  const alerts = await selectRows("weather_alerts", { select: "*", id: `eq.${alertId}`, limit: "1" });
  if (!alerts.length) return null;
  const logs = await selectRows("notification_logs", { select: "*", alert_id: `eq.${alertId}`, order: "created_at.asc" });
  const recipients = await selectRows("alert_recipients", { select: "*", alert_id: `eq.${alertId}`, order: "created_at.asc" });
  return { alert: alerts[0], recipients, logs };
}

export function mapSmsStatus(raw) {
  const status = String(raw || "").toUpperCase();
  if (["DELIVERED", "DELIVERED_TO_HANDSET", "DELIVERED_TO_OPERATOR"].includes(status)) return SMS_STATUS.DELIVERED;
  if (status.includes("DELIVER") && (status.includes("HANDSET") || status.includes("OPERATOR"))) return SMS_STATUS.DELIVERED;
  if (["SENDING", "SENT"].includes(status)) return SMS_STATUS.SENT;
  if (["FAILED", "UNDELIVERED", "REJECTED", "EXPIRED"].some((x) => status.includes(x))) return SMS_STATUS.FAILED;
  return SMS_STATUS.REQUEST_ACCEPTED;
}

export function mapCallStatus(raw, eventType = "") {
  const status = String(raw || "").toLowerCase();
  const event = String(eventType || "").toLowerCase();
  if (event === "answered" || status === "in-progress") return CALL_STATUS.ANSWERED;
  if (status === "queued") return CALL_STATUS.INITIATED;
  if (status === "ringing") return CALL_STATUS.RINGING;
  if (status === "completed") return CALL_STATUS.COMPLETED;
  if (status === "busy") return CALL_STATUS.BUSY;
  if (status === "no-answer") return CALL_STATUS.NO_ANSWER;
  return status === "failed" ? CALL_STATUS.FAILED : CALL_STATUS.INITIATED;
}

export async function updateProviderStatus({ providerMessageId, channel, status, error = "", rawPayload = null }) {
  if (!providerMessageId) return { updated: false };
  const logs = await selectRows("notification_logs", {
    select: "id,alert_id,user_id,recipient_id,channel,status",
    provider_message_id: `eq.${providerMessageId}`,
    channel: `eq.${channel}`,
    limit: "1"
  });
  if (!logs.length) return { updated: false };
  const log = logs[0];
  await updateRows("notification_logs", { id: log.id }, { status, error: error ? clean(error, 700) : null, raw_payload: rawPayload || null, updated_at: new Date().toISOString() });
  if (log.recipient_id) {
    const patch = channel === "sms" ? { sms_status: status, updated_at: new Date().toISOString() } : { call_status: status, updated_at: new Date().toISOString() };
    await updateRows("alert_recipients", { id: log.recipient_id }, patch);
  }
  return { updated: true, alertId: log.alert_id, userId: log.user_id, rawPayload };
}

export function messageConfigReady() {
  return Boolean(env("EXOTEL_API_KEY") && env("EXOTEL_API_TOKEN") && env("EXOTEL_ACCOUNT_SID"));
}

export function voiceConfigReady() {
  return Boolean(messageConfigReady() && env("EXOTEL_EXOPHONE") && env("EXOTEL_VOICE_FLOW_URL"));
}
