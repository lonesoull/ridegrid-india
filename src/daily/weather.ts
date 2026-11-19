import type { LngLat } from '../core/geo';

/** Weather (OsmAnd weather plugin): Open-Meteo forecast, free and keyless. */
export interface WeatherHour { t: number; temp: number; rainPct: number; rainMm: number; windKmh: number; code: number }
export interface Weather { now: WeatherHour; hours: WeatherHour[] }

const CODE: Record<number, string> = { 0: '☀️ Clear', 1: '🌤 Mostly clear', 2: '⛅ Partly cloudy', 3: '☁️ Cloudy', 45: '🌫 Fog', 48: '🌫 Fog', 51: '🌦 Drizzle', 53: '🌦 Drizzle', 55: '🌧 Drizzle',
  61: '🌧 Light rain', 63: '🌧 Rain', 65: '🌧 Heavy rain', 80: '🌦 Showers', 81: '🌧 Showers', 82: '⛈ Heavy showers', 95: '⛈ Thunderstorm', 96: '⛈ Thunderstorm + hail', 99: '⛈ Thunderstorm + hail' };
export const weatherText = (c: number) => CODE[c] ?? '🌡';

export async function weatherAt(p: LngLat, hours = 12): Promise<Weather | null> {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${p[1].toFixed(3)}&longitude=${p[0].toFixed(3)}&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,weather_code&forecast_hours=${hours}&timezone=auto`;
  const j = await fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const h = j?.hourly;
  if (!h?.time?.length) return null;
  const list: WeatherHour[] = h.time.map((t: string, i: number) => ({ t: Date.parse(t), temp: h.temperature_2m[i], rainPct: h.precipitation_probability[i] ?? 0, rainMm: h.precipitation[i] ?? 0, windKmh: h.wind_speed_10m[i], code: h.weather_code[i] }));
  return { now: list[0], hours: list };
}
