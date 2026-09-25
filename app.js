const DEFAULT_LOCATION = {
  name: "New Delhi",
  admin1: "Delhi",
  country: "India",
  latitude: 28.6139,
  longitude: 77.209
};
const WORLD_BOUNDS = [[-85.05112878, -180], [85.05112878, 180]];

const state = {
  location: DEFAULT_LOCATION,
  risk: null,
  map: null,
  mapReady: false,
  mapResizeObserver: null,
  selectedMarker: null,
  riskSourceReady: false,
  resourceMarkers: new Map(),
  places: [],
  requestId: 0,
  searchRequestId: 0,
  searchController: null,
  placesController: null,
  weatherCache: new Map(),
  lastWeather: null,
  pendingRegistration: null,
  lastFocusedElement: null,
  scrollFrame: 0
};

const $ = (id) => document.getElementById(id);

const actions = {
  LOW: {
    residents: ["Use normal heat precautions.", "Drink water regularly.", "Check updates if you work outdoors."],
    authorities: ["Maintain routine monitoring.", "Keep heat messages ready.", "Review hospital and cooling plans."]
  },
  WATCH: {
    residents: ["Increase hydration.", "Reduce long outdoor exposure.", "Take shade breaks.", "Check elderly people, children and people with health risks."],
    authorities: ["Increase public heat messaging.", "Prepare cooling centers if risk rises.", "Notify outdoor-work supervisors.", "Check water access in exposed areas."]
  },
  HIGH: {
    residents: ["Avoid unnecessary outdoor exposure.", "Use cooler indoor spaces.", "Take frequent water and rest breaks.", "Check vulnerable people nearby."],
    authorities: ["Consider opening cooling centers.", "Adjust outdoor-work hours.", "Increase emergency-department readiness.", "Issue heat-health warnings.", "Start vulnerable-person checks."]
  },
  EXTREME: {
    residents: ["Stay indoors or in a cooler safe place if possible.", "Avoid outdoor work except for urgent needs.", "Seek help for confusion, fainting, chest pain or heatstroke signs.", "Check elderly people, children, outdoor workers and people with health risks."],
    authorities: ["Open cooling centers.", "Increase emergency-department readiness.", "Shift outdoor work hours.", "Enforce hydration and rest requirements.", "Prepare disaster-response teams and power-grid capacity.", "Increase neighborhood outreach."]
  }
};

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function locationLabel(location) {
  return [location.name, location.admin1, location.country].filter(Boolean).join(", ");
}

function riskLevel(score) {
  if (score >= 82) return "EXTREME";
  if (score >= 64) return "HIGH";
  if (score >= 42) return "WATCH";
  return "LOW";
}

function riskColor(level, alpha = 1) {
  const colors = {
    LOW: `rgba(105, 217, 138, ${alpha})`,
    WATCH: `rgba(255, 194, 71, ${alpha})`,
    HIGH: `rgba(255, 114, 27, ${alpha})`,
    EXTREME: `rgba(255, 59, 48, ${alpha})`
  };
  return colors[level] || colors.WATCH;
}

function heatIndexC(tempC, rh) {
  const tempF = tempC * 9 / 5 + 32;
  if (tempF < 80) return tempC;
  const hiF =
    -42.379 + 2.04901523 * tempF + 10.14333127 * rh
    - 0.22475541 * tempF * rh - 0.00683783 * tempF ** 2
    - 0.05481717 * rh ** 2 + 0.00122874 * tempF ** 2 * rh
    + 0.00085282 * tempF * rh ** 2 - 0.00000199 * tempF ** 2 * rh ** 2;
  return (hiF - 32) * 5 / 9;
}

function apparentTemperatureC(tempC, rh, windKmh) {
  const windMs = windKmh / 3.6;
  const vaporPressure = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  return tempC + 0.33 * vaporPressure - 0.7 * windMs - 4;
}

function petC(tempC, rh, windKmh, radiation) {
  return tempC + (rh - 45) * 0.055 + radiation * 0.011 - Math.min(windKmh, 28) * 0.13;
}

function vulnerability(location) {
  const text = `${location.name || ""} ${location.admin1 || ""}`.toLowerCase();
  const metro = ["delhi", "mumbai", "kolkata", "chennai", "hyderabad", "ahmedabad", "bengaluru", "pune", "jaipur", "lucknow", "surat"].some((name) => text.includes(name));
  const coastal = ["mumbai", "chennai", "kolkata", "visakhapatnam", "kochi", "goa", "puducherry"].some((name) => text.includes(name));
  const dry = ["rajasthan", "jaipur", "jodhpur", "bikaner", "ahmedabad", "kutch"].some((name) => text.includes(name));
  const score = clamp(46 + (metro ? 18 : 0) + (coastal ? 8 : 0) + (dry ? 12 : 0), 35, 88);
  const notes = [
    metro ? "Dense urban areas can hold more heat through the day and night." : "Outdoor workers may face long heat exposure.",
    coastal ? "High humidity can make it harder for the body to cool down." : "Elderly people, children and people with health risks need extra checks.",
    dry ? "Strong sunlight and dry heat can raise daytime heat load." : "Prototype vulnerability will improve when official local layers are connected."
  ];
  return { score, notes };
}

function calculateRisk(current, location) {
  const heatIndex = heatIndexC(current.temperature, current.humidity);
  const apparent = current.apparent ?? apparentTemperatureC(current.temperature, current.humidity, current.wind);
  const pet = petC(current.temperature, current.humidity, current.wind, current.radiation);
  const vuln = vulnerability(location);
  const factors = {
    Temperature: clamp(((current.temperature - 26) / 18) * 100),
    Humidity: clamp(((current.humidity - 35) / 55) * 100),
    Wind: clamp(100 - (current.wind / 28) * 100),
    Radiation: clamp((current.radiation / 850) * 100),
    Vulnerability: vuln.score
  };
  const score = clamp(
    factors.Temperature * 0.28 +
    factors.Humidity * 0.19 +
    factors.Wind * 0.12 +
    factors.Radiation * 0.21 +
    factors.Vulnerability * 0.2
  );
  const level = riskLevel(score);
  return {
    score: Math.round(score),
    level,
    heatIndex,
    apparent,
    pet,
    factors,
    vuln,
    mortality: Math.round(clamp(score * 0.76 + vuln.score * 0.16 + Math.max(0, pet - 35) * 1.8)),
    hospital: Math.round(clamp(score * 0.82 + factors.Humidity * 0.12 + Math.max(0, heatIndex - 36) * 1.3))
  };
}

async function searchLocations(query, signal) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Location search failed");
  const data = await response.json();
  return data.results || [];
}

async function fetchWeather(location) {
  const cacheKey = `${Number(location.latitude).toFixed(3)}:${Number(location.longitude).toFixed(3)}`;
  const cached = state.weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.weather;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", location.latitude);
  url.searchParams.set("longitude", location.longitude);
  url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,shortwave_radiation");
  url.searchParams.set("forecast_days", "5");
  url.searchParams.set("timezone", "auto");
  const response = await fetch(url);
  if (!response.ok) throw new Error("Weather fetch failed");
  const weather = await response.json();
  state.weatherCache.set(cacheKey, { at: Date.now(), weather });
  if (state.weatherCache.size > 50) state.weatherCache.delete(state.weatherCache.keys().next().value);
  return weather;
}

function currentWeather(weather) {
  const hourly = weather.hourly;
  const now = Date.now();
  let index = 0;
  let best = Infinity;
  hourly.time.forEach((time, i) => {
    const diff = Math.abs(new Date(time).getTime() - now);
    if (diff < best) {
      best = diff;
      index = i;
    }
  });
  return weatherAt(hourly, index);
}

function weatherAt(hourly, index) {
  return {
    temperature: hourly.temperature_2m[index],
    humidity: hourly.relative_humidity_2m[index],
    apparent: hourly.apparent_temperature[index],
    wind: hourly.wind_speed_10m[index],
    windDirection: hourly.wind_direction_10m[index],
    radiation: hourly.shortwave_radiation[index],
    time: hourly.time[index]
  };
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value;
}

function setValue(id, value) {
  const node = $(id);
  if (node) node.value = value;
}

function renderCurrent(location, current, risk) {
  const label = locationLabel(location);
  setDashboardLoading(false);
  state.risk = risk;
  state.lastCurrent = current;
  setText("selectedLocation", label);
  setText("riskScore", risk.score);
  setText("riskLevel", risk.level);
  setText("riskSummary", `${risk.level} thermal stress. Heat, humidity, wind, radiation and vulnerability combine into this score.`);
  setText("temperature", `${round(current.temperature, 1)}°C`);
  setText("humidity", `${round(current.humidity)}%`);
  setText("wind", `${round(current.wind, 1)} km/h`);
  setText("radiation", `${round(current.radiation)} W/m²`);
  setText("heatIndex", `${round(risk.heatIndex, 1)}°C`);
  setText("apparentTemp", `${round(risk.apparent, 1)}°C`);
  setText("pet", `${round(risk.pet, 1)}°C`);
  setText("mortalityRisk", `${risk.mortality}/100`);
  setText("hospitalRisk", `${risk.hospital}/100`);
  const updatedAt = new Date();
  const lastUpdated = $("lastUpdated");
  if (lastUpdated) {
    lastUpdated.dateTime = updatedAt.toISOString();
    lastUpdated.textContent = updatedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  }
  setText("whyTitle", `${risk.score}/100 is ${risk.level}`);
  setText("whyText", whyText(risk));
  setValue("formLocation", label);
  setValue("formRiskLevel", risk.level);
  setValue("formRiskScore", risk.score);
  setValue("formRiskInfo", whyText(risk));
  const latField = $("formLat");
  const lonField = $("formLon");
  if (latField) latField.value = location.latitude;
  if (lonField) lonField.value = location.longitude;
  renderFactors(risk.factors);
  renderVulnerability(risk);
  renderActions(risk.level);
}

function whyText(risk) {
  const strong = Object.entries(risk.factors)
    .filter(([, value]) => value >= 60)
    .map(([key]) => key.toLowerCase());
  if (!strong.length) return "Current conditions are moderate, but exposure can still affect vulnerable people.";
  return `${strong.join(", ")} are pushing the local thermal stress score upward.`;
}

function renderFactors(factors) {
  const list = $("factorList");
  list.innerHTML = "";
  Object.entries(factors).forEach(([name, value]) => {
    const row = document.createElement("div");
    row.className = "factor";
    row.innerHTML = `<span>${name}</span><span class="bar"><i style="--value:${Math.round(value)}%"></i></span><span>${Math.round(value)}%</span>`;
    list.appendChild(row);
  });
}

function renderVulnerability(risk) {
  setText("vulnerabilityTitle", risk.vuln.score >= 70 ? "Higher vulnerability" : risk.vuln.score >= 52 ? "Moderate vulnerability" : "Lower vulnerability");
  const list = $("vulnerabilityList");
  list.innerHTML = "";
  risk.vuln.notes.forEach((note) => list.appendChild(li(note)));
}

function renderActions(level) {
  const chosen = actions[level] || actions.WATCH;
  const residents = $("residentActions");
  const authorities = $("authorityActions");
  residents.innerHTML = "";
  authorities.innerHTML = "";
  chosen.residents.forEach((item) => residents.appendChild(li(item)));
  chosen.authorities.forEach((item) => authorities.appendChild(li(item)));
}

function li(text) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

function renderTimeline(weather, location) {
  const timeline = $("timeline");
  timeline.innerHTML = "";
  const grouped = {};
  weather.hourly.time.forEach((time, i) => {
    const day = time.slice(0, 10);
    grouped[day] ||= [];
    grouped[day].push(weatherAt(weather.hourly, i));
  });

  Object.entries(grouped).slice(0, 5).forEach(([date, values]) => {
    const peak = values
      .map((item) => calculateRisk(item, location))
      .sort((a, b) => b.score - a.score)[0];
    const day = new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
    const card = document.createElement("article");
    card.className = "day";
    card.innerHTML = `
      <strong>${day}</strong>
      <b style="color:${riskColor(peak.level)}">${peak.level}</b>
      <span>${peak.score}/100 peak risk</span>
      <div class="day-meter"><i style="--value:${peak.score}%"></i></div>
    `;
    timeline.appendChild(card);
  });
}

function scheduleMapResize() {
  if (!state.map || typeof state.map.updateSize !== "function") return;
  cancelAnimationFrame(state.mapResizeFrame || 0);
  state.mapResizeFrame = requestAnimationFrame(() => {
    state.mapResizeFrame = requestAnimationFrame(() => {
      state.mapResizeFrame = 0;
      try { state.map.updateSize(); } catch (_) {}
    });
  });
}

function clearResourceMarkers() {
  if (!state.map || !state.resourceLayer) return;
  state.resourceLayer.getSource().clear();
  state.resourceMarkers = new Map();
}

function makeFeatureStyle(kind, selected = false) {
  const color = kind === "hospital" ? "#1677a8" : kind === "park" ? "#3f8b57" : riskColor(state.risk?.level || "WATCH", 1);
  return new ol.style.Style({
    image: new ol.style.Circle({
      radius: selected ? 10 : 8,
      fill: new ol.style.Fill({ color }),
      stroke: new ol.style.Stroke({ color: "#ffffff", width: selected ? 3 : 2 })
    })
  });
}

function updateMapOverlay(location, risk, current) {
  setText("mapOverlayLocation", locationLabel(location));
  if (current) {
    setText("mapTempDisplay", `${round(current.temperature, 1)}°C`);
    setText("mapHumidity", `${round(current.humidity)}%`);
    setText("mapWind", `${round(current.wind, 1)} km/h`);
    setText("mapHeatIdx", risk ? `${round(risk.heatIndex, 1)}°C` : "--°C");
  }
  const badge = $("mapRiskBadge");
  if (badge && risk) {
    badge.textContent = risk.level;
    badge.style.background = riskColor(risk.level, 1);
    badge.style.color = "#fff";
  }
  setText("mapRiskScore", risk ? risk.score : "--");
}

function syncMapResourceMarkers(places) {
  if (!state.mapReady || !state.resourceLayer) return;
  const view = state.map.getView();
  const center = view.getCenter();
  const zoom = view.getZoom();
  clearResourceMarkers();
  const source = state.resourceLayer.getSource();
  places.forEach((place) => {
    const feature = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([place.lon, place.lat])),
      place
    });
    feature.setStyle(makeFeatureStyle(place.category));
    source.addFeature(feature);
    state.resourceMarkers.set(place.id, { feature, place });
  });
  // Resource results must never auto-fit or recenter the user's map.
  if (center) view.setCenter(center);
  if (Number.isFinite(zoom)) view.setZoom(zoom);
}

function setSelectedMarker(location) {
  if (!state.selectedLayer) return;
  const source = state.selectedLayer.getSource();
  source.clear();
  const feature = new ol.Feature({
    geometry: new ol.geom.Point(ol.proj.fromLonLat([location.longitude, location.latitude])),
    kind: "selected"
  });
  feature.setStyle(new ol.style.Style({
    image: new ol.style.Circle({
      radius: 11,
      fill: new ol.style.Fill({ color: "#111827" }),
      stroke: new ol.style.Stroke({ color: "#ffffff", width: 4 })
    })
  }));
  source.addFeature(feature);
  state.selectedMarker = feature;
}

function updateRiskLayer(location, risk) {
  if (!state.riskLayer || !risk) return;
  const source = state.riskLayer.getSource();
  source.clear();
  const center = ol.proj.fromLonLat([location.longitude, location.latitude]);
  const feature = new ol.Feature(new ol.geom.Circle(center, Math.max(3500, Math.min(11000, 3500 + risk.score * 75))));
  const color = riskColor(risk.level, 0.18);
  feature.setStyle(new ol.style.Style({
    fill: new ol.style.Fill({ color }),
    stroke: new ol.style.Stroke({ color: riskColor(risk.level, 0.9), width: 3 })
  }));
  source.addFeature(feature);
}

function showIframeMap(location) {
  const host = $("map");
  if (!host) return;
  host.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.title = "Selected location map";
  iframe.loading = "lazy";
  iframe.referrerPolicy = "no-referrer-when-downgrade";
  const lat = Number(location.latitude), lon = Number(location.longitude);
  const d = 0.06;
  iframe.src = `https://www.openstreetmap.org/export/embed.html?bbox=${lon-d}%2C${lat-d}%2C${lon+d}%2C${lat+d}&layer=mapnik&marker=${lat}%2C${lon}`;
  iframe.style.cssText = "width:100%;height:100%;border:0;display:block";
  host.appendChild(iframe);
  setText("mapStatus", "Fallback map loaded. Search another location to recenter it.");
}

async function initMap() {
  if (state.map) return;
  const element = $("map");
  if (!element) return;
  try {
    const start = performance.now();
    while ((element.clientWidth <= 0 || element.clientHeight <= 0) && performance.now() - start < 4000) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (element.clientWidth <= 0 || element.clientHeight <= 0) throw new Error("Map container has no size");
    if (!window.ol) throw new Error("OpenLayers failed to load");

    const baseLayer = new ol.layer.Tile({
      source: new ol.source.OSM({
        attributions: "© OpenStreetMap contributors"
      })
    });
    state.riskLayer = new ol.layer.Vector({ source: new ol.source.Vector() });
    state.selectedLayer = new ol.layer.Vector({ source: new ol.source.Vector() });
    state.resourceLayer = new ol.layer.Vector({ source: new ol.source.Vector() });

    state.map = new ol.Map({
      target: element,
      layers: [baseLayer, state.riskLayer, state.resourceLayer, state.selectedLayer],
      view: new ol.View({
        center: ol.proj.fromLonLat([state.location.longitude, state.location.latitude]),
        zoom: 12,
        minZoom: 2,
        maxZoom: 19
      }),
      controls: ol.control.defaults({ attribution: true, zoom: true })
    });

    state.mapReady = true;
    setSelectedMarker(state.location);
    updateMapOverlay(state.location, state.risk, state.lastCurrent);
    if (state.risk) updateRiskLayer(state.location, state.risk);
    syncMapResourceMarkers(state.places);
    setText("mapStatus", "Map ready. Search a location to load nearby hospitals and parks.");
    scheduleMapResize();

    state.map.on("singleclick", (event) => {
      state.map.forEachFeatureAtPixel(event.pixel, (feature) => {
        const place = feature.get("place");
        if (!place) return;
        const popup = new ol.Overlay({ element: document.createElement("div"), positioning: "bottom-center", stopEvent: false, offset: [0, -12] });
        const node = popup.getElement();
        node.className = "ol-resource-popup";
        node.innerHTML = `<strong>${escapeHtml(place.name)}</strong><br>${escapeHtml(place.subtype)} · ${escapeHtml(distanceLabel(place.distanceKm))}`;
        state.map.addOverlay(popup);
        popup.setPosition(event.coordinate);
        setTimeout(() => state.map.removeOverlay(popup), 5000);
        return true;
      });
    });

    const resizeTarget = element.parentElement;
    if ("ResizeObserver" in window && resizeTarget) {
      state.mapResizeObserver = new ResizeObserver(() => scheduleMapResize());
      state.mapResizeObserver.observe(resizeTarget);
    }
    window.addEventListener("resize", scheduleMapResize, { passive: true });
    window.addEventListener("orientationchange", scheduleMapResize, { passive: true });
  } catch (error) {
    console.error("[map] OpenLayers initialization failed:", error);
    showIframeMap(state.location);
  }
}

function updateMap(location, risk, current) {
  updateMapOverlay(location, risk, current);
  if (!state.map || !state.mapReady) return;
  const view = state.map.getView();
  view.animate({ center: ol.proj.fromLonLat([location.longitude, location.latitude]), zoom: 12, duration: 500 });
  setSelectedMarker(location);
  updateRiskLayer(location, risk);
  syncMapResourceMarkers(state.places);
  setText("mapStatus", `${locationLabel(location)} · ${risk.level} · ${risk.score}/100 thermal risk · nearby hospitals and parks shown on map.`);
  scheduleMapResize();
}

// ── Direct-browser resource fetch (no Vercel timeout) ──────────────────────
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

function normalizeOsmElement(el, refLat, refLon) {
  const tags = el.tags || {};
  const lat = Number(el.lat ?? el.center?.lat);
  const lon = Number(el.lon ?? el.center?.lon);
  const name = tags.name || tags["name:en"] || tags["name:te"] || tags["name:hi"];
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const isHospital = ["hospital","clinic","doctors","health_centre","health_center"].includes(tags.amenity) ||
    ["hospital","clinic","doctor","centre","center","pharmacy"].includes(tags.healthcare);
  const isPark = ["park","garden","nature_reserve","recreation_ground","playground"].includes(tags.leisure);
  if (!isHospital && !isPark) return null;
  if (tags.access === "private") return null;
  return {
    id: `osm-${el.type}-${el.id}`,
    name: String(name).slice(0, 140),
    category: isHospital ? "hospital" : "park",
    subtype: (tags.amenity || tags.healthcare || tags.leisure || "place").slice(0, 80),
    lat, lon,
    distanceKm: haversineKm(refLat, refLon, lat, lon),
    address: [tags["addr:housenumber"], tags["addr:street"], tags["addr:suburb"], tags["addr:city"]].filter(Boolean).join(", "),
    phone: String(tags.phone || tags["contact:phone"] || "").slice(0, 80),
    website: String(tags.website || tags["contact:website"] || "").slice(0, 500),
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`
  };
}

async function tryOverpass(lat, lon) {
  const radius = 10000;
  const q = `[out:json][timeout:28];(nwr(around:${radius},${lat},${lon})["amenity"~"^(hospital|clinic|doctors|health_centre|health_center|pharmacy)$"];nwr(around:${radius},${lat},${lon})["healthcare"];nwr(around:${radius},${lat},${lon})["leisure"~"^(park|garden|nature_reserve|recreation_ground|playground)$"];);out center tags;`;
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 28000);
      const r = await fetch(ep, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: q, signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) continue;
      const d = await r.json();
      const seen = new Set();
      const places = (d.elements || [])
        .map(el => normalizeOsmElement(el, lat, lon))
        .filter(Boolean)
        .filter(p => { const k = `${p.name.toLowerCase()}|${p.lat.toFixed(4)}`; return !seen.has(k) && seen.add(k); })
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 40);
      if (places.length > 0) return places;
    } catch (_) {}
  }
  return null;
}

async function tryNominatim(lat, lon) {
  const d = 0.18;
  const box = `${lon - d},${lat + d},${lon + d},${lat - d}`;
  const searches = [
    { param: "amenity=hospital",    cat: "hospital", sub: "hospital" },
    { param: "amenity=clinic",      cat: "hospital", sub: "clinic" },
    { param: "amenity=doctors",     cat: "hospital", sub: "clinic" },
    { param: "amenity=pharmacy",    cat: "hospital", sub: "pharmacy" },
    { param: "leisure=park",        cat: "park",     sub: "park" },
    { param: "leisure=garden",      cat: "park",     sub: "garden" },
    { param: "leisure=playground",  cat: "park",     sub: "playground" }
  ];
  const all = [];
  const seen = new Set();
  for (const s of searches) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&${s.param}&bounded=1&viewbox=${box}&limit=10`;
      const r = await fetch(url, { headers: { "User-Agent": "THRIVE-HeatRisk/1.0 (health-tool)" } });
      if (!r.ok) continue;
      const items = await r.json();
      for (const item of items) {
        const name = item.display_name?.split(",")[0]?.trim() || item.name;
        if (!name) continue;
        const iLat = Number(item.lat), iLon = Number(item.lon);
        const k = `${name.toLowerCase()}|${iLat.toFixed(3)}`;
        if (seen.has(k)) continue; seen.add(k);
        all.push({ id: `nom-${item.place_id}`, name: name.slice(0, 140), category: s.cat, subtype: s.sub, lat: iLat, lon: iLon, distanceKm: haversineKm(lat, lon, iLat, iLon), address: "", phone: "", website: "", osmUrl: item.osm_type && item.osm_id ? `https://www.openstreetmap.org/${item.osm_type}/${item.osm_id}` : "" });
      }
      await new Promise(r => setTimeout(r, 350)); // Nominatim rate limit
    } catch (_) {}
  }
  return all.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 40);
}

async function searchNearbyResources(location, requestId) {
  const lat = Number(location.latitude), lon = Number(location.longitude);
  const overpass = await tryOverpass(lat, lon);
  if (overpass && overpass.length > 0) return overpass;
  if (requestId !== state.requestId) return [];
  const nominatim = await tryNominatim(lat, lon);
  return nominatim || [];
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function distanceLabel(km) {
  return km < 1 ? "< 1 km" : `${km.toFixed(1)} km`;
}

function focusResource(place, item) {
  if (state.map && state.mapReady) {
    state.map.getView().animate({ center: ol.proj.fromLonLat([place.lon, place.lat]), zoom: 15, duration: 400 });
  }
  document.querySelectorAll(".resource-item.is-active").forEach((node) => node.classList.remove("is-active"));
  item?.classList.add("is-active");
}

function selectDisplayPlaces(places) {
  const hospitals = places
    .filter((place) => place.category === "hospital")
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const parks = places
    .filter((place) => place.category === "park")
    .sort((a, b) => a.distanceKm - b.distanceKm);

  // Keep the resource panel deterministic: four hospitals + one park when a
  // park exists; otherwise show the five nearest hospitals. This also keeps
  // the map viewport and panel height stable as the Overpass result count grows.
  if (parks.length > 0) return [...hospitals.slice(0, 4), parks[0]];
  return hospitals.slice(0, 5);
}

function renderPlaces(places, requestId) {
  state.places = places;
  if (requestId !== state.requestId) return;
  clearResourceMarkers();
  const byCategory = { hospital: $("hospitalList"), park: $("parkList") };
  Object.values(byCategory).forEach((node) => { node.replaceChildren(); });
  places.forEach((place) => {
    if (requestId !== state.requestId) return;
    const directionUrl = place.osmUrl || `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=17/${place.lat}/${place.lon}`;
    const card = document.createElement("article");
    card.className = "resource-item";
    card.dataset.resourceId = place.id;
    const title = document.createElement("strong"); title.textContent = place.name; card.appendChild(title);
    const type = document.createElement("span"); type.textContent = `${place.subtype} · ${distanceLabel(place.distanceKm)}`; card.appendChild(type);
    [place.address, place.openingHours].filter(Boolean).forEach((value) => {
      const meta = document.createElement("small"); meta.textContent = value; card.appendChild(meta);
    });
    const source = document.createElement("small"); source.textContent = "Source: community-mapped resource data"; source.textContent = "Source: OpenStreetMap / OpenFreeMap resource data"; card.appendChild(source);
    const focus = document.createElement("button"); focus.type = "button"; focus.textContent = "View on map";
    focus.addEventListener("click", () => focusResource(place, card)); card.appendChild(focus);
    const links = document.createElement("div"); links.className = "hospital-links";
    const directions = document.createElement("a"); directions.href = directionUrl; directions.target = "_blank"; directions.rel = "noopener noreferrer"; directions.textContent = "Directions"; links.appendChild(directions);
    if (place.phone) {
      const call = document.createElement("a"); call.href = `tel:${String(place.phone).replace(/[^+\d]/g, "")}`; call.textContent = "Call"; links.appendChild(call);
    }
    if (place.website) {
      try {
        const websiteUrl = new URL(place.website);
        if (["http:", "https:"].includes(websiteUrl.protocol)) {
          const website = document.createElement("a"); website.href = websiteUrl.href; website.target = "_blank";
          website.rel = "noopener noreferrer"; website.textContent = "Website"; links.appendChild(website);
        }
      } catch (_) {}
    }
    card.appendChild(links);
    byCategory[place.category].appendChild(card);
  });
  syncMapResourceMarkers(places);
}

async function fetchPlaces(location, requestId) {
  state.placesController?.abort();
  const controller = new AbortController(); state.placesController = controller;
  $("hospitalList").replaceChildren(); $("parkList").replaceChildren();
  setText("intelligenceLocation", locationLabel(location));
  setText("hospitalStatus", "Searching for nearby hospitals and parks…");
  setText("aiStatus", "Waiting for nearby resource results and current heat risk…");
  setText("aiHeatSummary", ""); setText("aiHospitalSummary", ""); setText("aiParkSummary", ""); setText("aiDisclaimer", "");
  $("aiActions").replaceChildren(); $("aiChatLog")?.replaceChildren();
  try {
    const places = await searchNearbyResources(location, requestId);
    if (controller.signal.aborted || requestId !== state.requestId) return null;
    const displayPlaces = selectDisplayPlaces(places);
    renderPlaces(displayPlaces, requestId);
    const hospitalCount = displayPlaces.filter((p) => p.category === "hospital").length;
    const parkCount = displayPlaces.filter((p) => p.category === "park").length;
    setText("hospitalStatus", displayPlaces.length
      ? `${hospitalCount} nearby hospital${hospitalCount === 1 ? "" : "s"}${parkCount ? " + 1 nearby park" : ""} shown on the map.`
      : "The map found no nearby hospitals or parks within 10 km.");
    return displayPlaces;
  } catch (error) {
    if (controller.signal.aborted || requestId !== state.requestId) return null;
    console.error("[places] Nearby resource lookup failed:", error);
    setText("hospitalStatus", "Could not load nearby places right now. Check your connection and try searching again.");
    setText("aiStatus", "The automatic location analysis is waiting for nearby resource data.");
    return [];
  }
}

async function analyzeLocation(location, risk, current, places, requestId) {
  if (requestId !== state.requestId) return;
  setText("aiStatus", "AI is analyzing this location…");
  try {
    const response = await fetch("/api/location-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: state.placesController?.signal,
      body: JSON.stringify({ location, risk: { score: risk.score, level: risk.level }, weather: { temperatureC: current.temperature, humidityPercent: current.humidity }, places })
    });
    if (!response.ok) throw new Error("AI analysis unavailable");
    const analysis = await response.json();
    if (requestId !== state.requestId) return;
    setText("aiStatus", analysis.locationSummary || "Not available");
    setText("aiHeatSummary", analysis.heatHealthSummary || "Not available");
    setText("aiDisclaimer", analysis.disclaimer || "");
    setText("aiHospitalSummary", analysis.hospitalSummary || "Not available");
    setText("aiParkSummary", analysis.parkSummary || "Not available");
    [...(analysis.hospitals || []), ...(analysis.parks || [])].forEach((note) => {
      const card = [...document.querySelectorAll(".resource-item")].find((node) => node.dataset.resourceId === note.id);
      if (!card || !note.reason || note.reason === "Not available") return;
      const reason = document.createElement("small"); reason.textContent = note.reason; card.appendChild(reason);
    });
    (analysis.recommendedActions || []).forEach((action) => $("aiActions").appendChild(li(action)));
    appendAIMessage(analysis.chatMessage || `Automatic scan complete for ${locationLabel(location)}. I used this location automatically and loaded nearby hospitals and parks.`);
  } catch (error) {
    if (error.name === "AbortError" || requestId !== state.requestId) return;
    setText("aiStatus", "AI location analysis is temporarily unavailable. Raw mapped results are still available below.");
  }
}

async function loadLocation(location) {
  const requestId = ++state.requestId;
  const latitude = Number(location.latitude), longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    setDashboardLoading(false);
    setText("riskSummary", "This location does not have valid coordinates. Choose another search result.");
    setText("mapStatus", "Invalid location coordinates.");
    return;
  }
  state.placesController?.abort();
  setDashboardLoading(true);
  if (state.map && state.mapReady) {
    state.map.getView().setCenter(ol.proj.fromLonLat([longitude, latitude]));
    state.map.getView().setZoom(12);
    setSelectedMarker(location);
    updateMapOverlay(location, null, null);
  } else if ($("map")?.querySelector("iframe")) {
    showIframeMap(location);
    updateMapOverlay(location, null, null);
  }
  clearResourceMarkers();
  state.places = [];
  $("hospitalList").replaceChildren(); $("parkList").replaceChildren();
  setText("aiStatus", "Waiting for current weather and nearby resources…");
  setText("aiHeatSummary", ""); setText("aiHospitalSummary", ""); setText("aiParkSummary", "");
  setText("aiDisclaimer", "");
  $("aiActions").replaceChildren();
  state.risk = null;
  location.latitude = latitude; location.longitude = longitude;
  state.location = location;
  $("locationInput").value = location.name || "";
  setValue("formLocation", locationLabel(location));
  setValue("formRiskLevel", ""); setValue("formRiskScore", ""); setValue("formRiskInfo", "");
  $("formLat").value = latitude; $("formLon").value = longitude;
  setText("selectedLocation", locationLabel(location));
  setText("riskLevel", "Loading");
  setText("riskScore", "--");
  setText("riskSummary", "Loading live Open-Meteo data for the selected location.");
  setText("mapStatus", `Loading ${locationLabel(location)}...`);
  setText("hospitalStatus", "Waiting for weather and nearby resource lookup...");
  const placesPromise = fetchPlaces(location, requestId);

  try {
    const weather = await fetchWeather(location);
    if (requestId !== state.requestId) return;
    const current = currentWeather(weather);
    if (![current.temperature, current.humidity, current.wind, current.radiation].every(Number.isFinite)) throw new Error("Incomplete weather data");
    const risk = calculateRisk(current, location);
    renderCurrent(location, current, risk);
    renderTimeline(weather, location);
    updateMap(location, risk, current);
    const places = await placesPromise;
    if (requestId !== state.requestId) return;
    setText("aiStatus", `Automatic search complete for ${locationLabel(location)}. The map and lists below show nearby hospitals and parks.`);
    setText("aiHeatSummary", `${risk.level} modeled heat risk · ${risk.score}/100. Use the resource lists below to choose nearby facilities.`);
    setText("aiHospitalSummary", `${places.filter((p) => p.category === "hospital").length} nearby hospitals/clinics found.`);
    setText("aiParkSummary", `${places.filter((p) => p.category === "park").length} nearby parks/green spaces found.`);
  } catch (error) {
    if (requestId !== state.requestId) return;
    setText("riskLevel", "Unavailable");
    setText("riskSummary", "Live weather could not be loaded for this location. Try again or choose another location.");
    setText("mapStatus", "Weather data unavailable.");
    setText("aiStatus", "Location search is waiting for live weather data.");
    setDashboardLoading(false);
  }
}

function setDashboardLoading(loading) {
  document.body.classList.toggle("data-loading", loading);
  ["selectedLocation", "riskScore", "riskLevel", "riskSummary", "temperature", "humidity", "wind", "radiation", "heatIndex", "apparentTemp", "pet", "mortalityRisk", "hospitalRisk", "mapOverlayLocation", "mapTempDisplay", "mapHumidity", "mapWind", "mapHeatIdx", "mapRiskScore"].forEach((id) => {
    const node = $(id);
    if (node) node.classList.toggle("loading-skeleton", loading);
  });
  document.querySelectorAll(".timeline, .hospital-list, .factor-list").forEach((node) => node.classList.toggle("content-loading", loading));
}

function captureUtm() {
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  const params = new URLSearchParams(location.search);
  const fresh = Object.fromEntries(keys.filter((key) => params.get(key)).map((key) => [key, params.get(key)]));
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("thrive_utm") || "{}"); } catch (_) {}
  const merged = { ...saved, ...fresh };
  try { localStorage.setItem("thrive_utm", JSON.stringify(merged)); } catch (_) {}
  const fieldMap = { utm_source: "utmSource", utm_medium: "utmMedium", utm_campaign: "utmCampaign", utm_term: "utmTerm", utm_content: "utmContent" };
  keys.forEach((key) => setValue(fieldMap[key], merged[key] || ""));
  setValue("landingUrl", location.href.split("#")[0]);
}

function initTheme() {
  let theme = "light";
  try { theme = localStorage.getItem("thrive_theme") || "light"; } catch (_) {}
  document.documentElement.dataset.theme = theme;
  const button = $("themeToggle");
  if (!button) return;
  const update = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    button.textContent = dark ? "☀" : "☾";
    button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    button.title = dark ? "Switch to light mode" : "Switch to dark mode";
    const meta = $("themeColorMeta");
    if (meta) meta.content = dark ? "#16120f" : "#f8ecd7";
  };
  button.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("thrive_theme", next); } catch (_) {}
    update();
  });
  update();
}

function initCookieBanner() {
  const banner = $("cookieBanner");
  const accepted = (() => { try { return localStorage.getItem("thrive_cookie_notice") === "accepted"; } catch (_) { return false; } })();
  if (banner && !accepted) banner.hidden = false;
  $("cookieAccept")?.addEventListener("click", () => {
    try { localStorage.setItem("thrive_cookie_notice", "accepted"); } catch (_) {}
    if (banner) banner.hidden = true;
  });
}

function initNavigation() {
  const header = $("siteHeader");
  const menuToggle = $("mobileMenuToggle");
  const nav = $("mainNav");
  const closeMenu = () => {
    header?.classList.remove("menu-open");
    menuToggle?.setAttribute("aria-expanded", "false");
    menuToggle?.setAttribute("aria-label", "Open navigation");
  };
  menuToggle?.addEventListener("click", () => {
    const open = !header.classList.contains("menu-open");
    header.classList.toggle("menu-open", open);
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
    if (open) scheduleMapResize();
  });
  nav?.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
  document.addEventListener("click", (event) => {
    if (!header?.classList.contains("menu-open")) return;
    if (!header.contains(event.target)) closeMenu();
  });
}

function initScrollTools() {
  const progress = $("scrollProgress")?.firstElementChild;
  const topButton = $("backToTop");
  const header = $("siteHeader");
  const update = () => {
    state.scrollFrame = 0;
    const doc = document.documentElement;
    const scrollable = Math.max(1, doc.scrollHeight - window.innerHeight);
    const percent = clamp((window.scrollY / scrollable) * 100, 0, 100);
    if (progress) progress.style.width = `${percent}%`;
    topButton?.classList.toggle("is-visible", window.scrollY > 520);
    header?.classList.toggle("is-scrolled", window.scrollY > 8);
  };
  window.addEventListener("scroll", () => {
    if (state.scrollFrame) return;
    state.scrollFrame = requestAnimationFrame(update);
  }, { passive: true });
  topButton?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  update();
}

function initSiteSearch() {
  const dialog = $("siteSearchDialog");
  const toggle = $("siteSearchToggle");
  const input = $("siteSearchInput");
  const results = $("siteSearchResults");
  if (!dialog || !toggle || !input || !results) return;

  const index = [...document.querySelectorAll("main section[id], main section:not([id])")].map((section, i) => {
    const heading = section.querySelector("h2, h3")?.textContent?.trim() || section.querySelector(".kicker")?.textContent?.trim() || `Section ${i + 1}`;
    const text = section.textContent.replace(/\s+/g, " ").trim().slice(0, 260);
    return { id: section.id || "main-content", heading, text };
  });

  const close = () => {
    dialog.hidden = true;
    document.body.classList.remove("dialog-open");
    state.lastFocusedElement?.focus?.();
  };
  const open = () => {
    state.lastFocusedElement = document.activeElement;
    dialog.hidden = false;
    document.body.classList.add("dialog-open");
    input.value = "";
    results.innerHTML = "<p class='search-empty'>Start typing to search THRIVE.</p>";
    requestAnimationFrame(() => input.focus());
  };
  toggle.addEventListener("click", open);
  dialog.querySelectorAll("[data-close-search]").forEach((node) => node.addEventListener("click", close));
  dialog.querySelector(".modal-close")?.addEventListener("click", close);
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    if (!query) { results.innerHTML = "<p class='search-empty'>Start typing to search THRIVE.</p>"; return; }
    const matches = index.filter((item) => `${item.heading} ${item.text}`.toLowerCase().includes(query)).slice(0, 8);
    if (!matches.length) { results.innerHTML = "<p class='search-empty'>No matching THRIVE content found.</p>"; return; }
    results.replaceChildren(...matches.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      const strong = document.createElement("strong"); strong.textContent = item.heading;
      const small = document.createElement("small"); small.textContent = item.text;
      button.append(strong, small);
      button.addEventListener("click", () => {
        close();
        const target = item.id ? document.getElementById(item.id) : document.getElementById("main-content");
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return button;
    }));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) close();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); open(); }
  });
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
  document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
  return Promise.resolve();
}

function riskSnapshot() {
  const location = state.location ? locationLabel(state.location) : "Selected location";
  const risk = state.risk;
  const current = state.lastCurrent;
  if (!risk || !current) return `THRIVE — ${location}\nLive risk data is still loading.`;
  const chosen = actions[risk.level] || actions.WATCH;
  return [
    `THRIVE HEAT-RISK SNAPSHOT`,
    `Location: ${location}`,
    `Risk: ${risk.level} (${risk.score}/100)`,
    `Temperature: ${round(current.temperature, 1)}°C`,
    `Humidity: ${round(current.humidity)}%`,
    `Wind: ${round(current.wind, 1)} km/h`,
    `Heat Index: ${round(risk.heatIndex, 1)}°C`,
    `PET approximation: ${round(risk.pet, 1)}°C`,
    `Mortality-risk signal: ${risk.mortality}/100`,
    `Hospitalization-risk signal: ${risk.hospital}/100`,
    `What to do: ${chosen.residents.slice(0, 3).join("; ")}`,
    `Updated: ${new Date().toLocaleString("en-IN")}`
  ].join("\n");
}

function initReportTools() {
  $("copyRiskButton")?.addEventListener("click", async () => {
    const status = $("copyStatus");
    try { await copyText(riskSnapshot()); setText("copyStatus", "Copied"); setTimeout(() => setText("copyStatus", ""), 1800); }
    catch (_) { setText("copyStatus", "Copy failed"); setTimeout(() => setText("copyStatus", ""), 1800); }
  });
  $("printRiskButton")?.addEventListener("click", () => window.print());
}

function openConfirmModal(payload) {
  const modal = $("confirmModal");
  if (!modal) return;
  state.pendingRegistration = payload;
  state.lastFocusedElement = document.activeElement;
  setText("confirmText", `Submit ${payload.name}'s information for ${locationLabel(payload.location)} to the THRIVE Formspree inbox for manual handling. Current THRIVE risk: ${payload.risk?.level || "not yet calculated"}.`);
  modal.hidden = false;
  document.body.classList.add("dialog-open");
  requestAnimationFrame(() => $("confirmSubmit")?.focus());
}

function closeConfirmModal() {
  const modal = $("confirmModal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("dialog-open");
  state.pendingRegistration = null;
  state.lastFocusedElement?.focus?.();
}

async function submitRegistration(payload, form) {
  const status = $("formStatus");
  const submitButton = form.querySelector("button[type=submit]");
  submitButton.disabled = true;
  form.classList.remove("form-success", "form-error");
  form.classList.add("form-submitting");
  status.textContent = "Sending information…";
  status.className = "form-status";
  try {
    const response = await fetch(form.action, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new FormData(form)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || "Form submission failed");
    }
    status.innerHTML = `<strong>INFORMATION SENT</strong><br>Thanks, ${escapeHtml(payload.name)}. Your details and current THRIVE risk snapshot were sent for manual review.`;
    status.classList.add("success");
    form.classList.add("form-success");
    form.reset();
    captureUtm();
    closeConfirmModal();
  } catch (error) {
    status.textContent = error.message || "Your information could not be sent right now. Please try again.";
    status.classList.add("error");
    form.classList.add("form-error");
    closeConfirmModal();
  } finally {
    submitButton.disabled = false;
    form.classList.remove("form-submitting");
  }
}

function setupRegisterForm() {
  const form = $("registerForm");
  if (!form) return;
  const status = $("formStatus");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    form.classList.remove("form-success", "form-error");
    status.textContent = "";
    status.className = "form-status";
    if (!$("consentBox").checked) {
      status.textContent = "Please agree to the Privacy Policy consent above to register.";
      status.classList.add("error"); form.classList.add("form-error"); return;
    }
    const currentLocation = state.location;
    const currentRisk = state.risk;
    const payload = {
      name: form.elements.name.value.trim(),
      phone: form.elements.phone.value.trim(),
      email: form.elements.email.value.trim(),
      consent: true,
      location: {
        label: locationLabel(currentLocation), name: currentLocation?.name || "", admin1: currentLocation?.admin1 || "", country: currentLocation?.country || "",
        latitude: currentLocation?.latitude ?? null, longitude: currentLocation?.longitude ?? null
      },
      risk: currentRisk ? { level: currentRisk.level, score: currentRisk.score, summary: whyText(currentRisk) } : null,
      attribution: {
        utm_source: $("utmSource")?.value || "", utm_medium: $("utmMedium")?.value || "", utm_campaign: $("utmCampaign")?.value || "", utm_term: $("utmTerm")?.value || "", utm_content: $("utmContent")?.value || "",
        landing_url: $("landingUrl")?.value || location.href.split("#")[0]
      }
    };
    if (!payload.name || !payload.phone || !payload.email) {
      status.textContent = "Please fill in your name, phone number and email.";
      status.classList.add("error"); form.classList.add("form-error"); return;
    }
    openConfirmModal(payload);
  });
  $("confirmSubmit")?.addEventListener("click", () => {
    if (state.pendingRegistration) submitRegistration(state.pendingRegistration, form);
  });
  $("cancelConfirm")?.addEventListener("click", closeConfirmModal);
  $("confirmModal")?.querySelector(".confirm-backdrop")?.addEventListener("click", closeConfirmModal);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && $("confirmModal") && !$("confirmModal").hidden) closeConfirmModal(); });
}

function setupSearch() {
  const form = $("searchForm");
  const results = $("searchResults");
  let activeQuery = "";
  $("locationInput").addEventListener("input", (event) => {
    if (event.target.value.trim() === activeQuery) return;
    state.searchRequestId++;
    state.searchController?.abort();
    results.hidden = true;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("locationInput").value.trim();
    if (!query) return;
    activeQuery = query;
    state.searchController?.abort();
    const controller = new AbortController(); state.searchController = controller;
    const searchRequestId = ++state.searchRequestId;
    results.hidden = false;
    results.innerHTML = "<button type=\"button\" disabled>Searching...</button>";
    try {
      const places = await searchLocations(query, controller.signal);
      if (searchRequestId !== state.searchRequestId) return;
      if (!places.length) {
        results.innerHTML = "<button type=\"button\" disabled>No location found. Try another name.</button>";
        return;
      }
      results.innerHTML = "";
      places.forEach((place) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = locationLabel(place);
        button.addEventListener("click", () => {
          state.searchRequestId++;
          state.searchController?.abort();
          results.hidden = true;
          loadLocation(place);
        });
        results.appendChild(button);
      });
    } catch (error) {
      if (error.name === "AbortError" || searchRequestId !== state.searchRequestId) return;
      results.innerHTML = "<button type=\"button\" disabled>Search unavailable right now.</button>";
    }
  });
}


async function boot() {
  initTheme();
  initCookieBanner();
  initNavigation();
  initScrollTools();
  initSiteSearch();
  initReportTools();
  captureUtm();
  setupSearch();
  setupRegisterForm();
  setDashboardLoading(true);
  state.location = DEFAULT_LOCATION;
  if (document.fonts?.ready) await document.fonts.ready.catch(() => {});
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await initMap();
  loadLocation(DEFAULT_LOCATION);
}

window.addEventListener("DOMContentLoaded", boot, { once: true });
