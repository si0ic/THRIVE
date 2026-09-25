import { env, required } from "./config.js";

function exotelBase() {
  const subdomain = env("EXOTEL_SUBDOMAIN", "api.exotel.com").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${subdomain}`;
}

function authHeader() {
  return `Basic ${Buffer.from(`${required("EXOTEL_API_KEY")}:${required("EXOTEL_API_TOKEN")}`).toString("base64")}`;
}

function cleanResponseMessage(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function exotelRequest(path, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(`${exotelBase()}${path}`, {
      method: "POST",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: new URLSearchParams(params),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Exotel request timed out after 15 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) {
    const detail = cleanResponseMessage(raw);
    const label = response.status === 401 ? "Exotel authentication failed" : response.status === 429 ? "Rate limit reached" : response.status === 400 ? "Provider rejected request" : `Exotel request failed (${response.status})`;
    const error = new Error(detail ? `${label}: ${detail}` : label);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function sendSms({ to, body, statusCallback }) {
  const sender = required("EXOTEL_SMS_SENDER_ID");
  const entityId = required("EXOTEL_DLT_ENTITY_ID");
  const templateId = required("EXOTEL_DLT_TEMPLATE_ID");
  const data = {
    From: sender,
    To: to,
    Body: body,
    DltEntityId: entityId,
    DltTemplateId: templateId
  };
  if (statusCallback) data.StatusCallback = statusCallback;
  return exotelRequest(`/v1/Accounts/${encodeURIComponent(required("EXOTEL_ACCOUNT_SID"))}/Sms/send`, data);
}

export async function makeCall({ to, statusCallback, customField = "" }) {
  const sid = required("EXOTEL_ACCOUNT_SID");
  const params = new URLSearchParams();
  params.set("From", to);
  params.set("CallerId", required("EXOTEL_EXOPHONE"));
  params.set("Url", required("EXOTEL_VOICE_FLOW_URL"));
  params.set("CallType", "trans");
  if (statusCallback) params.set("StatusCallback", statusCallback);
  if (customField) params.set("CustomField", customField.slice(0, 128));
  // For Connect Number to Call Flow, keep the request to the documented
  // Flow API contract. Exotel's current docs define terminal/answered
  // callbacks here and note that extended callback events do not apply when
  // using a VoiceUrl. The terminal callback remains the authoritative
  // completion/failure signal for this serverless flow.
  return exotelRequest(`/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect`, params);
}

export function extractSmsSid(data) {
  return data?.SMSMessage?.Sid || data?.smsmessage?.sid || data?.Sid || "";
}

export function extractCallSid(data) {
  return data?.Call?.Sid || data?.Call?.sid || data?.Sid || "";
}
