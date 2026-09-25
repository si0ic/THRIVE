function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

export function riskLevel(score) {
  if (score >= 82) return "EXTREME";
  if (score >= 64) return "HIGH";
  if (score >= 42) return "WATCH";
  return "LOW";
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

function vulnerability(location = {}) {
  const text = `${location.name || ""} ${location.admin1 || ""}`.toLowerCase();
  const metro = ["delhi", "mumbai", "kolkata", "chennai", "hyderabad", "ahmedabad", "bengaluru", "pune", "jaipur", "lucknow", "surat"].some((name) => text.includes(name));
  const coastal = ["mumbai", "chennai", "kolkata", "visakhapatnam", "kochi", "goa", "puducherry"].some((name) => text.includes(name));
  const dry = ["rajasthan", "jaipur", "jodhpur", "bikaner", "ahmedabad", "kutch"].some((name) => text.includes(name));
  const score = clamp(46 + (metro ? 18 : 0) + (coastal ? 8 : 0) + (dry ? 12 : 0), 35, 88);
  return { score };
}

export function calculateRisk(current, location) {
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

export function whyText(risk) {
  const strong = Object.entries(risk?.factors || {})
    .filter(([, value]) => value >= 60)
    .map(([key]) => key.toLowerCase());
  if (!strong.length) return "Current conditions are moderate, but exposure can still affect vulnerable people.";
  return `${strong.join(", ")} are pushing the local thermal stress score upward.`;
}

export async function currentWeather(location) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", location.latitude);
  url.searchParams.set("longitude", location.longitude);
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,wind_direction_10m,shortwave_radiation");
  url.searchParams.set("timezone", "auto");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
  const data = await response.json();
  const c = data.current || {};
  const values = {
    temperature: Number(c.temperature_2m),
    humidity: Number(c.relative_humidity_2m),
    apparent: Number(c.apparent_temperature),
    wind: Number(c.wind_speed_10m),
    windDirection: Number(c.wind_direction_10m),
    radiation: Number(c.shortwave_radiation),
    time: c.time || new Date().toISOString()
  };
  if (![values.temperature, values.humidity, values.wind, values.radiation].every(Number.isFinite)) {
    throw new Error("Open-Meteo returned incomplete current weather data");
  }
  return values;
}
