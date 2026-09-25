const MAX_PLACES = 80;
const LEVEL_ACTION = {
  LOW: "Keep normal heat precautions and stay hydrated.",
  WATCH: "Reduce long outdoor exposure and take regular shade or water breaks.",
  HIGH: "Limit unnecessary outdoor exposure and check on people who may be vulnerable to heat.",
  EXTREME: "Use a cooler safe place, avoid unnecessary outdoor exposure, and seek urgent medical help for severe heat-illness symptoms."
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function clean(value, max = 800) {
  return typeof value === "string"
    ? value.replace(/[<>]/g, "").trim().slice(0, max)
    : "";
}

function distanceKm(aLat, aLon, bLat, bLon) {
  const rad = (v) => v * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) *
      Math.cos(rad(bLat)) *
      Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function normalizePlaces(input, lat, lon) {
  return (Array.isArray(input) ? input.slice(0, MAX_PLACES) : []).flatMap((place) => {
    if (!place || typeof place.id !== "string" || typeof place.name !== "string") return [];
    if (!["hospital", "park"].includes(place.category)) return [];

    const placeLat = Number(place.lat);
    const placeLon = Number(place.lon);
    if (!Number.isFinite(placeLat) || !Number.isFinite(placeLon)) return [];

    return [{
      id: clean(place.id, 180),
      name: clean(place.name, 180),
      category: place.category,
      subtype: clean(place.subtype, 90),
      lat: placeLat,
      lon: placeLon,
      distanceKm: distanceKm(lat, lon, placeLat, placeLon),
      address: clean(place.address, 260),
      phone: clean(place.phone, 80),
      businessStatus: clean(place.businessStatus, 60),
      googleMapsURI: clean(place.googleMapsURI, 600)
    }];
  });
}

function nearest(places, category) {
  return places
    .filter((p) => p.category === category)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function fallbackAnalysis(payload, places, question = "") {
  const hospitals = nearest(places, "hospital");
  const parks = nearest(places, "park");
  const h = hospitals.slice(0, 3);
  const p = parks.slice(0, 3);
  const risk = payload.risk || { score: 0, level: "LOW" };
  const location = payload.location?.name || "the selected location";

  if (question) {
    const q = question.toLowerCase();
    if (q.includes("hospital") || q.includes("clinic") || q.includes("medical") || q.includes("nearest") || q.includes("closest")) {
      return {
        answer: h.length
          ? `The closest mapped hospital or clinic to ${location} is ${h[0].name}, about ${h[0].distanceKm.toFixed(1)} km away. The modeled heat risk is ${risk.level} at ${risk.score}/100.`
          : `No nearby mapped hospital or clinic was returned for ${location}.`
      };
    }
    if (q.includes("park") || q.includes("green")) {
      return {
        answer: p.length
          ? `Nearby green spaces include ${p.slice(0, 2).map((x) => `${x.name} (${x.distanceKm.toFixed(1)} km)`).join(" and ")}.`
          : `No nearby mapped park or green space was returned for ${location}.`
      };
    }
    return {
      answer: `${location} has a modeled ${String(risk.level).toLowerCase()} heat risk of ${risk.score}/100. ${h.length ? `Nearest mapped hospital/clinic: ${h[0].name} (${h[0].distanceKm.toFixed(1)} km).` : "No nearby hospital/clinic was returned."} ${p.length ? `Nearest mapped park: ${p[0].name} (${p[0].distanceKm.toFixed(1)} km).` : "No nearby park was returned."}`
    };
  }

  const action = LEVEL_ACTION[risk.level] || LEVEL_ACTION.WATCH;
  return {
    locationSummary: `Automatic scan for ${location}: the resource map returned ${hospitals.length} hospitals/clinics and ${parks.length} parks/green spaces.`,
    heatHealthSummary: `Modeled THRIVE heat risk is ${risk.score}/100 (${risk.level}). ${action}`,
    hospitalSummary: hospitals.length
      ? `${hospitals.length} nearby hospitals/clinics found; nearest is ${hospitals[0].name} at ${hospitals[0].distanceKm.toFixed(1)} km.`
      : "No nearby hospitals/clinics were returned by the resource map.",
    parkSummary: parks.length
      ? `${parks.length} nearby parks/green spaces found; nearest is ${parks[0].name} at ${parks[0].distanceKm.toFixed(1)} km.`
      : "No nearby parks/green spaces were returned by the resource map.",
    recommendedActions: [action],
    hospitals: h.map((x) => ({ id: x.id, reason: `${x.distanceKm.toFixed(1)} km from the selected location.` })),
    parks: p.map((x) => ({ id: x.id, reason: `${x.distanceKm.toFixed(1)} km from the selected location.` })),
    chatMessage: `I automatically checked ${location}. I found ${hospitals.length} hospitals/clinics and ${parks.length} parks nearby. The current modeled heat risk is ${risk.level} (${risk.score}/100).`,
    disclaimer: "THRIVE's score is a modeled prototype signal, not an official government warning. Mapped place results can change as community data is updated."
  };
}

function parseModelJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

function responseText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

async function callOpenAI(payload, question) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const model = String(process.env.OPENAI_MODEL || "gpt-5.6-luna").trim();
  if (!apiKey) return null;

  const system = question
    ? [
        "You are the THRIVE Hospital AI assistant.",
        "Use only the supplied location, modeled risk, weather and mapped hospital and park data.",
        "Never invent hospitals, parks, services, availability, opening hours or distances.",
        "Answer the user's question in clear easy English, under 120 words.",
        "Do not diagnose or prescribe.",
        "Return JSON only: {\"answer\":\"...\"}."
      ].join(" ")
    : [
        "You are the THRIVE location intelligence assistant.",
        "Use only supplied location, modeled risk, weather and mapped hospital and park data.",
        "Never invent places or geographic facts.",
        "Explain modeled heat risk clearly without presenting it as an official government warning.",
        "Return JSON only with: locationSummary, heatHealthSummary, hospitalSummary, parkSummary, recommendedActions, hospitals, parks, chatMessage, disclaimer.",
        "For hospitals and parks, select only supplied place IDs, up to 3 per category."
      ].join(" ");

  const user = JSON.stringify({
    location: payload.location,
    risk: payload.risk,
    weather: payload.weather,
    hospitals: payload.hospitals,
    parks: payload.parks,
    ...(question ? { question } : {})
  });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input: user
    })
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`OpenAI ${response.status}: ${message.slice(0, 240)}`);
  }

  const data = await response.json();
  return parseModelJson(responseText(data));
}

function safeAnalysis(generated, fallback, places) {
  if (!generated || typeof generated !== "object") return fallback;

  const allowed = new Map(places.map((p) => [p.id, p]));
  const select = (list, category) => {
    const chosen = Array.isArray(list) ? list : [];
    const ids = chosen
      .map((row) => typeof row === "string" ? row : row?.id)
      .filter((id, index, all) => allowed.has(id) && places.find((p) => p.id === id)?.category === category && all.indexOf(id) === index)
      .slice(0, 3);

    return ids.map((id) => {
      const original = chosen.find((row) => (typeof row === "string" ? row : row?.id) === id);
      return {
        id,
        reason: clean(original?.reason, 220) || `${allowed.get(id).distanceKm.toFixed(1)} km from the selected location.`
      };
    });
  };

  return {
    locationSummary: clean(generated.locationSummary, 700) || fallback.locationSummary,
    heatHealthSummary: clean(generated.heatHealthSummary, 700) || fallback.heatHealthSummary,
    hospitalSummary: clean(generated.hospitalSummary, 700) || fallback.hospitalSummary,
    parkSummary: clean(generated.parkSummary, 700) || fallback.parkSummary,
    recommendedActions: Array.isArray(generated.recommendedActions)
      ? generated.recommendedActions.map((x) => clean(x, 220)).filter(Boolean).slice(0, 4)
      : fallback.recommendedActions,
    hospitals: select(generated.hospitals, "hospital"),
    parks: select(generated.parks, "park"),
    chatMessage: clean(generated.chatMessage, 700) || fallback.chatMessage,
    disclaimer: clean(generated.disclaimer, 500) || fallback.disclaimer
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  let input;
  try {
    input = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  } catch (_) {
    return res.status(400).json({ error: "Invalid JSON body." });
  }

  const loc = input?.location || {};
  const lat = Number(loc.latitude);
  const lon = Number(loc.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({ error: "Valid selected coordinates are required." });
  }

  const risk = input?.risk;
  const weather = input?.weather;
  if (
    !risk ||
    !["LOW", "WATCH", "HIGH", "EXTREME"].includes(String(risk.level)) ||
    !Number.isFinite(Number(risk.score)) ||
    !weather ||
    !Number.isFinite(Number(weather.temperatureC)) ||
    !Number.isFinite(Number(weather.humidityPercent))
  ) {
    return res.status(400).json({ error: "Valid risk and weather context are required." });
  }

  const places = normalizePlaces(input?.places, lat, lon);
  const payload = {
    location: {
      name: clean(loc.name, 120),
      admin1: clean(loc.admin1, 120),
      country: clean(loc.country, 120),
      latitude: lat,
      longitude: lon
    },
    risk: {
      score: Number(risk.score),
      level: String(risk.level)
    },
    weather: {
      temperatureC: Number(weather.temperatureC),
      humidityPercent: Number(weather.humidityPercent)
    },
    hospitals: places.filter((p) => p.category === "hospital"),
    parks: places.filter((p) => p.category === "park")
  };

  const question = clean(input.question, 500);
  const fallback = fallbackAnalysis(payload, places, question);

  try {
    const generated = await callOpenAI(payload, question);
    if (question) {
      return res.status(200).json(generated?.answer
        ? { answer: clean(generated.answer, 900) }
        : fallback);
    }
    return res.status(200).json(safeAnalysis(generated, fallback, places));
  } catch (error) {
    console.error("[location-ai]", error.message);
    return res.status(200).json(fallback);
  }
}
