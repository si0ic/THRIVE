const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

function json(status, body) {
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": status === 200 ? "public, max-age=300" : "no-store" }, body: JSON.stringify(body) };
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = (v) => v * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

async function query(endpoint, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", Accept: "application/json" }, body, signal: controller.signal });
    if (!response.ok) throw new Error(`Overpass ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function normalize(item, lat, lon) {
  const tags = item.tags || {};
  const placeLat = Number(item.lat ?? item.center?.lat);
  const placeLon = Number(item.lon ?? item.center?.lon);
  const name = tags.name || tags["name:en"];
  if (!name || !Number.isFinite(placeLat) || !Number.isFinite(placeLon)) return null;
  const medical = ["hospital", "clinic", "doctors"].includes(tags.amenity) || ["hospital", "clinic", "doctor", "centre", "center"].includes(tags.healthcare) || tags.emergency === "yes";
  const green = ["park", "garden", "nature_reserve"].includes(tags.leisure);
  if (!medical && !green) return null;
  if (tags.access === "private") return null;
  const category = medical ? "hospital" : "park";
  const subtype = tags.amenity || tags.healthcare || tags.leisure || "mapped resource";
  const address = [tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"], tags["addr:city"]].filter(Boolean).join(", ").slice(0, 240);
  return {
    id: `osm-${item.type}-${item.id}`,
    name: String(name).slice(0, 160),
    category,
    subtype: String(subtype).slice(0, 80),
    lat: placeLat,
    lon: placeLon,
    distanceKm: distanceKm(lat, lon, placeLat, placeLon),
    address,
    phone: String(tags.phone || tags["contact:phone"] || "").slice(0, 80),
    website: String(tags.website || tags["contact:website"] || "").slice(0, 500),
    osmUrl: `https://www.openstreetmap.org/${item.type}/${item.id}`
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || 10, 2), 15);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return res.status(400).json({ error: "Valid coordinates are required." });
  const radius = Math.round(radiusKm * 1000);
  const queryText = `[out:json][timeout:20];(nwr(around:${radius},${lat},${lon})["amenity"~"^(hospital|clinic|doctors)$"];nwr(around:${radius},${lat},${lon})["healthcare"~"^(hospital|clinic|doctor|centre|center)$"];nwr(around:${radius},${lat},${lon})["emergency"="yes"];nwr(around:${radius},${lat},${lon})["leisure"~"^(park|garden|nature_reserve)$"];);out center tags;`;
  let data = null, lastError = null;
  for (const endpoint of ENDPOINTS) {
    try { data = await query(endpoint, queryText); if (data) break; }
    catch (error) { lastError = error; }
  }
  if (!data) return res.status(502).json({ error: "Nearby resource provider unavailable.", detail: lastError?.message || "unknown" });
  const seen = new Set();
  const places = (data.elements || []).map((item) => normalize(item, lat, lon)).filter(Boolean).filter((place) => {
    const key = `${place.name.toLowerCase()}|${place.lat.toFixed(5)}|${place.lon.toFixed(5)}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 40);
  return res.status(200).json({ places, source: "OpenStreetMap via Overpass" });
}
