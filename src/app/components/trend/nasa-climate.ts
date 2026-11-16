/**
 * Tendências climáticas a partir da NASA POWER (https://power.larc.nasa.gov), sem chave de API.
 * Não depende do Angular. Duas requisições por ponto:
 *   1) MENSAL  1981 → ano passado: dá a "normal" (média 1991-2020 de cada mês) e a tendência por década;
 *   2) DIÁRIA  últimos ~40 dias:   dá o estado atual (média dos últimos 30 dias com dado).
 * Unidades: T2M °C, RH2M %, PS kPa (vira hPa; é pressão na SUPERFÍCIE, então a tendência é a do próprio local).
 */

export type VarKey = 'temperature' | 'humidity' | 'pressure';

export const POWER_FILL_LIMIT = -990;            // a POWER marca "sem dado" com -999
export const NORMAL_FROM = 1991;                 // normal climatológica padrão da OMM: 1991-2020
export const NORMAL_TO = 2020;
export const FIRST_YEAR = 1981;                  // início da série meteorológica da POWER (MERRA-2)

const PARAMS = 'T2M,RH2M,PS';
const BASE = 'https://power.larc.nasa.gov/api/temporal';

/** valor[ano][mês 1..12] (null = sem dado) */
export type MonthlyGrid = Record<VarKey, Map<number, (number | null)[]>>;

export interface DailyPoint {
  /** 'AAAAMMDD' */
  day: string;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;   // hPa
}

export function monthlyUrl(lat: number, lon: number, lastYear: number): string {
  return (
    `${BASE}/monthly/point?parameters=${PARAMS}&community=AG` +
    `&longitude=${lon}&latitude=${lat}&start=${FIRST_YEAR}&end=${lastYear}&format=JSON`
  );
}

export function dailyUrl(lat: number, lon: number, startYmd: string, endYmd: string): string {
  return (
    `${BASE}/daily/point?parameters=${PARAMS}&community=AG` +
    `&longitude=${lon}&latitude=${lat}&start=${startYmd}&end=${endYmd}&format=JSON`
  );
}

/** 'AAAAMMDD' (UTC) de `msAgo` milissegundos atrás. */
export function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

const num = (v: unknown): number | null => (typeof v === 'number' && v > POWER_FILL_LIMIT ? v : null);

/** Resposta mensal → grade ano × mês. As chaves são 'AAAAMM'; 'AAAA13' é a média anual e é ignorada. */
export function parseMonthly(res: any): MonthlyGrid | null {
  const p = res?.properties?.parameter;
  if (!p?.T2M) return null;

  const grid: MonthlyGrid = { temperature: new Map(), humidity: new Map(), pressure: new Map() };
  const src: Record<VarKey, string> = { temperature: 'T2M', humidity: 'RH2M', pressure: 'PS' };

  for (const key of Object.keys(src) as VarKey[]) {
    const obj = p[src[key]];
    if (!obj) continue;
    for (const k of Object.keys(obj)) {
      const year = Number(k.slice(0, 4));
      const month = Number(k.slice(4, 6));
      if (!(month >= 1 && month <= 12) || !Number.isFinite(year)) continue;
      let v = num(obj[k]);
      if (v !== null && key === 'pressure') v *= 10;                  // kPa → hPa
      if (!grid[key].has(year)) grid[key].set(year, new Array(12).fill(null));
      grid[key].get(year)![month - 1] = v;
    }
  }
  return grid.temperature.size ? grid : null;
}

/** Resposta diária → lista ordenada por dia. */
export function parseDaily(res: any): DailyPoint[] {
  const p = res?.properties?.parameter;
  if (!p?.T2M) return [];
  return Object.keys(p.T2M)
    .sort()
    .map((day) => {
      const ps = num(p.PS?.[day]);
      return {
        day,
        temperature: num(p.T2M[day]),
        humidity: num(p.RH2M?.[day]),
        pressure: ps === null ? null : ps * 10,
      };
    });
}

async function getJson(url: string, signal?: AbortSignal): Promise<any> {
  const r = await fetch(url, { signal });
  if (!r.ok) throw Object.assign(new Error(`POWER ${r.status}`), { status: r.status });
  return r.json();
}

/** Baixa as duas séries do ponto. `nowMs` existe só para teste. */
export async function fetchClimate(lat: number, lon: number, signal?: AbortSignal, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const lastYear = now.getUTCFullYear() - 1;                           // o mensal fecha no ano passado
  const day = 86400000;

  const [m, d] = await Promise.all([
    getJson(monthlyUrl(lat, lon, lastYear), signal),
    getJson(dailyUrl(lat, lon, ymd(nowMs - 39 * day), ymd(nowMs)), signal),
  ]);

  const monthly = parseMonthly(m);
  if (!monthly) throw new Error('A NASA POWER não devolveu dados mensais para este ponto.');
  return { monthly, daily: parseDaily(d), lastYear };
}