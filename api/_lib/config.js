export function env(name, fallback = "") {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

export function required(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function baseUrl(req) {
  const configured = env("APP_BASE_URL");
  if (configured) return configured.replace(/\/$/, "");
  const proto = String(req.headers?.["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}
