import { env, required } from "./config.js";

function dbConfig() {
  const url = required("SUPABASE_URL").replace(/\/$/, "");
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

function headers(prefer = "") {
  const { key } = dbConfig();
  const value = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json"
  };
  if (prefer) value.Prefer = prefer;
  return value;
}

function queryString(filters = {}) {
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return "";
  return "?" + entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

async function request(path, options = {}) {
  const { url } = dbConfig();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers(options.prefer || ""), ...(options.headers || {}) }
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`Supabase ${response.status}: ${message.slice(0, 500)}`);
  }
  return data;
}

export async function selectRows(table, params = {}) {
  return request(`${table}${queryString(params)}`, { method: "GET" });
}

export async function insertRows(table, rows) {
  return request(table, {
    method: "POST",
    prefer: "return=representation",
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows])
  });
}

export async function updateRows(table, filters, patch) {
  const params = Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, `eq.${value}`]));
  return request(`${table}${queryString(params)}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: JSON.stringify(patch)
  });
}

export async function deleteRows(table, filters) {
  const params = Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, `eq.${value}`]));
  return request(`${table}${queryString(params)}`, { method: "DELETE", prefer: "return=minimal" });
}

export function isDatabaseConfigured() {
  return Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
}
