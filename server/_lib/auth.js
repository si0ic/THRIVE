import crypto from "node:crypto";
import { env, required } from "./config.js";

const COOKIE = "thrive_admin";
const TTL_SECONDS = 8 * 60 * 60;

function base64url(value) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unbase64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function sign(value) {
  return base64url(crypto.createHmac("sha256", required("SESSION_SECRET")).update(value).digest());
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createToken() {
  const payload = JSON.stringify({ sub: "admin", exp: Math.floor(Date.now() / 1000) + TTL_SECONDS });
  const body = base64url(payload);
  return `${body}.${sign(body)}`;
}

function parseCookie(header = "") {
  const entry = header.split(";").map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`));
  return entry ? entry.slice(COOKIE.length + 1) : "";
}

export function adminAuthenticated(req) {
  const token = parseCookie(req.headers?.cookie || "");
  if (!token) return false;
  const [body, signature] = token.split(".");
  if (!body || !signature || !safeEqual(signature, sign(body))) return false;
  try {
    const payload = JSON.parse(unbase64url(body));
    return payload?.sub === "admin" && Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function setAdminCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=${createToken()}; Path=/; Max-Age=${TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
}

export function clearAdminCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

export function requireAdmin(req, res) {
  if (!adminAuthenticated(req)) {
    res.status(401).json({ ok: false, error: "Administrator authentication required." });
    return false;
  }
  return true;
}

export function adminPasswordMatches(password) {
  const configured = required("ADMIN_PASSWORD");
  const left = Buffer.from(String(password || ""));
  const right = Buffer.from(configured);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function cronAuthenticated(req) {
  const secret = env("CRON_SECRET");
  if (!secret) return false;
  const auth = String(req.headers?.authorization || "");
  return auth === `Bearer ${secret}`;
}
