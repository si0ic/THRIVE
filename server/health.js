export default function handler(req, res) {
  res.status(200).json({ ok: true, service: "THRIVE", runtime: "vercel-node", timestamp: new Date().toISOString() });
}
