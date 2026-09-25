const $ = (id) => document.getElementById(id);

const state = { users: [], selected: new Set(), poller: null };

function esc(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function setStatus(node, text, ok = false) {
  node.textContent = text;
  node.classList.toggle("success", ok);
  node.classList.toggle("error", !ok);
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { Accept: "application/json", ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function paramsFromMainPage() {
  const params = new URLSearchParams(location.search);
  const map = { location: "alertLocation", lat: "alertLatitude", lon: "alertLongitude", risk: "alertRiskLevel", score: "alertRiskScore", temp: "alertTemperature" };
  Object.entries(map).forEach(([key, id]) => {
    const value = params.get(key);
    if (value) $(id).value = value;
  });
  if (!$("alertMessage").value) $("alertMessage").value = "Avoid unnecessary outdoor exposure, move to a cooler place, drink water regularly, and check vulnerable people.";
}

function normalizeUserPhone(phone) { return String(phone || "").replace(/[()\s-]/g, ""); }

function renderUsers() {
  const host = $("usersList");
  if (!state.users.length) {
    host.innerHTML = "<p class='admin-help'>No registered users are available. Registration must be completed on the THRIVE home page first.</p>";
    return;
  }
  host.innerHTML = state.users.map((user) => {
    const eligible = user.alert_enabled && user.consent && /^\+[1-9]\d{7,14}$/.test(normalizeUserPhone(user.phone_number));
    const checked = state.selected.has(user.id) ? "checked" : "";
    const disabled = eligible ? "" : "disabled";
    const badges = [user.sms_enabled ? "SMS" : null, user.call_enabled ? "CALL" : null, user.consent ? "OPT-IN" : "NO CONSENT"].filter(Boolean).map((item) => `<span class='user-badge'>${esc(item)}</span>`).join("");
    return `<label class='user-row ${eligible ? "" : "disabled"}'>
      <input type='checkbox' data-user-id='${esc(user.id)}' ${checked} ${disabled}/>
      <span class='user-main'><strong>${esc(user.name)}</strong><small>${esc(normalizeUserPhone(user.phone_number))} · ${esc(user.location_label)}</small></span>
      <span class='user-badges'>${badges}</span>
    </label>`;
  }).join("");
  host.querySelectorAll("input[data-user-id]").forEach((box) => box.addEventListener("change", () => {
    if (box.checked) state.selected.add(box.dataset.userId); else state.selected.delete(box.dataset.userId);
  }));
}

function formPayload() {
  return {
    recipientIds: [...state.selected],
    location: { label: $("alertLocation").value.trim(), latitude: Number($("alertLatitude").value), longitude: Number($("alertLongitude").value) },
    riskLevel: $("alertRiskLevel").value,
    riskScore: Number($("alertRiskScore").value),
    temperatureC: Number($("alertTemperature").value),
    message: $("alertMessage").value.trim(),
    sendSms: $("sendSms").checked,
    sendCall: $("sendCall").checked,
    testMode: $("testMode").checked
  };
}

async function sendAlert(mode) {
  const status = $("actionStatus");
  const payload = formPayload();
  if (!payload.recipientIds.length) return setStatus(status, "Select at least one eligible recipient.");
  if (!["sms", "call", "both"].includes(mode)) return;
  payload.sendSms = mode !== "call";
  payload.sendCall = mode !== "sms";
  const button = mode === "sms" ? $("sendSmsButton") : mode === "call" ? $("sendCallButton") : $("sendBothButton");
  button.disabled = true;
  setStatus(status, `${mode === "both" ? "Sending SMS + calls" : mode === "sms" ? "Sending SMS" : "Starting calls"}…`, true);
  try {
    const result = await api("/api/alerts/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const failed = result.results.filter((item) => item.status === "FAILED").length;
    const testCount = result.results.filter((item) => item.status === "TEST_MODE").length;
    setStatus(status, `Alert ${result.alertId} created. ${result.results.length - failed} channel jobs accepted${testCount ? `; ${testCount} test-mode previews` : ""}.`, failed === 0);
    await loadAlerts();
    startPolling(result.alertId);
  } catch (error) {
    setStatus(status, error.message || "Alert request failed.");
  } finally { button.disabled = false; }
}

function statusClass(status) { return `status-${String(status || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`; }

function renderAlertDetail(detail) {
  const recipientMap = new Map((detail.alert_recipients || []).map((r) => [r.id, r]));
  const logs = detail.notification_logs || [];
  const byRecipient = new Map();
  logs.forEach((log) => {
    if (!byRecipient.has(log.recipient_id)) byRecipient.set(log.recipient_id, []);
    byRecipient.get(log.recipient_id).push(log);
  });
  return `<div class='alert-detail'><div class='alert-detail-head'><strong>${esc(detail.alert.location_label)}</strong><span class='risk-pill risk-${esc(String(detail.alert.risk_level).toLowerCase())}'>${esc(detail.alert.risk_level)} · ${esc(detail.alert.risk_score)}/100</span></div>
    <small>${esc(new Date(detail.alert.created_at).toLocaleString("en-IN"))} · ${esc(detail.alert.temperature_c)}°C ${detail.alert.automatic ? "· AUTOMATIC" : "· MANUAL"} ${detail.alert.test_mode ? "· TEST MODE" : ""}</small>
    <div class='alert-recipient-results'>${[...recipientMap.entries()].map(([id, recipient]) => {
      const recipientLogs = byRecipient.get(id) || [];
      return `<div class='alert-recipient-row'><div><strong>${esc(recipient.phone_number)}</strong></div><div>${recipient.sms_status ? `<span class='delivery-status ${statusClass(recipient.sms_status)}'>SMS ${esc(recipient.sms_status)}</span>` : ""} ${recipient.call_status ? `<span class='delivery-status ${statusClass(recipient.call_status)}'>CALL ${esc(recipient.call_status)}</span>` : ""}</div><div class='recipient-errors'>${recipientLogs.filter((log) => log.error).map((log) => `<span>${esc(log.channel)}: ${esc(log.error)}</span>`).join("")}</div></div>`;
    }).join("")}</div></div>`;
}

async function loadAlerts() {
  try {
    const result = await api("/api/admin/alerts?limit=12");
    const alerts = result.alerts || [];
    $("alertsList").innerHTML = alerts.length ? alerts.map((a) => `<button type='button' class='alert-list-item' data-alert-id='${esc(a.id)}'><span><strong>${esc(a.location_label)}</strong><small>${esc(a.risk_level)} · ${esc(a.temperature_c)}°C · ${esc(new Date(a.created_at).toLocaleString("en-IN"))}</small></span><span>Open →</span></button><div id='detail-${esc(a.id)}'></div>`).join("") : "<p class='admin-help'>No alerts have been created yet.</p>";
    $("alertsList").querySelectorAll(".alert-list-item").forEach((button) => button.addEventListener("click", () => loadAlertDetail(button.dataset.alertId)));
  } catch (error) { $("alertsList").innerHTML = `<p class='admin-help'>Could not load alerts: ${esc(error.message)}</p>`; }
}

async function loadAlertDetail(id) {
  const host = $(`detail-${id}`);
  if (!host) return;
  try { const result = await api(`/api/admin/alerts?id=${encodeURIComponent(id)}`); host.innerHTML = renderAlertDetail({ alert: result.alert, alert_recipients: result.recipients, notification_logs: result.logs }); } catch (error) { host.innerHTML = `<p class='admin-help'>Could not load delivery status: ${esc(error.message)}</p>`; }
}

function startPolling(alertId) {
  clearInterval(state.poller);
  let rounds = 0;
  state.poller = setInterval(async () => {
    rounds += 1;
    await loadAlertDetail(alertId);
    if (rounds >= 30) clearInterval(state.poller);
  }, 5000);
}

async function loadSystemStatus() {
  const host = $("integrationStatus");
  if (!host) return;
  try {
    const result = await api("/api/admin/status");
    const labels = { database: "Supabase database", adminSession: "Admin session", sms: "SMS + DLT", voice: "Voice call flow", webhookSecret: "Exotel webhooks", appBaseUrl: "App base URL", cronSecret: "Vercel Cron", testMode: "Test mode", testNumber: "Test number" };
    host.innerHTML = Object.entries(result.checks || {}).map(([key, ready]) => `<div class='integration-check'><span>${esc(labels[key] || key)}</span><strong class='integration-${ready ? "ok" : "missing"}'>${ready ? "READY" : "MISSING"}</strong></div>`).join("");
  } catch (error) {
    host.innerHTML = `<p class='admin-help'>Could not read configuration status: ${esc(error.message)}</p>`;
  }
}

async function loadUsers() {
  try { const result = await api("/api/admin/users"); state.users = result.users || []; state.selected = new Set(state.users.filter((u) => u.alert_enabled && u.consent).map((u) => u.id)); renderUsers(); } catch (error) { $("usersList").innerHTML = `<p class='admin-help'>Could not load users: ${esc(error.message)}</p>`; }
}

async function bootDashboard() {
  $("loginSection").hidden = true;
  $("dashboardSection").hidden = false;
  $("logoutButton").hidden = false;
  $("backendStatus").textContent = "Admin session active";
  paramsFromMainPage();
  await Promise.all([loadSystemStatus(), loadUsers(), loadAlerts()]);
}

async function init() {
  try { const result = await api("/api/admin/me"); if (result.authenticated) return bootDashboard(); } catch {}
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const status = $("loginStatus");
    try { await api("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("adminPassword").value }) }); await bootDashboard(); }
    catch (error) { setStatus(status, error.message || "Sign-in failed."); }
  });
}

$("refreshUsers").addEventListener("click", loadUsers);
$("refreshIntegration").addEventListener("click", loadSystemStatus);
$("refreshAlerts").addEventListener("click", loadAlerts);
$("sendSmsButton").addEventListener("click", () => sendAlert("sms"));
$("sendCallButton").addEventListener("click", () => sendAlert("call"));
$("sendBothButton").addEventListener("click", () => sendAlert("both"));
$("runAutomatic").addEventListener("click", async () => {
  const output = $("automaticOutput");
  output.hidden = false; output.textContent = "Running…";
  try { output.textContent = JSON.stringify(await api("/api/alerts/automatic", { method: "POST" }), null, 2); await loadAlerts(); }
  catch (error) { output.textContent = error.message || "Automatic check failed."; }
});
$("logoutButton").addEventListener("click", async () => { try { await api("/api/admin/logout", { method: "POST" }); location.reload(); } catch (error) { alert(error.message); } });

const passwordToggle = $("toggleAdminPassword");
passwordToggle?.addEventListener("click", () => {
  const input = $("adminPassword");
  if (!input) return;
  const isPassword = input.type === "password";
  input.type = isPassword ? "text" : "password";
  passwordToggle.textContent = isPassword ? "Hide" : "Show";
  passwordToggle.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
});

window.addEventListener("DOMContentLoaded", init, { once: true });
