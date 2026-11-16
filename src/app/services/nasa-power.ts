/**
 * NASA POWER (https://power.larc.nasa.gov): dados meteorológicos por hora, sem chave de API.
 * A API entrega UM ponto por requisição; este arquivo monta a URL, converte a resposta para o formato
 * que o globo já usa (temperature_2m, relative_humidity_2m, pressure_msl, wind_speed_10m, wind_direction_10m)
 * e acerta a janela de horas. Não depende do Angular.
 */

export const POWER_PARAMS = 'T2M,RH2M,PS,WS10M,WD10M';

/** A POWER marca "sem dado" com -999. */
const POWER_FILL_LIMIT = -990;

export interface PointSeries {
  latitude: number;
  longitude: number;
  hourly: {
    time: string[];                       // 'AAAA-MM-DDTHH:00' (UTC)
    temperature_2m: (number | null)[];    // °C
    relative_humidity_2m: (number | null)[]; // %
    pressure_msl: (number | null)[];      // hPa, reduzida ao nível do mar
    wind_speed_10m: (number | null)[];    // km/h
    wind_direction_10m: (number | null)[]; // ° (de onde o vento vem)
  };
}

/** Datas (AAAAMMDD, UTC) da janela: dos últimos `daysBack` dias até hoje. */
export function dateRangeUtc(daysBack: number, nowMs = Date.now()): { start: string; end: string } {
  const day = 86400000;
  const today = Math.floor(nowMs / day) * day;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  return { start: fmt(today - (daysBack - 1) * day), end: fmt(today) };
}

export function powerUrl(lat: number, lon: number, start: string, end: string, community = 'SB'): string {
  return (
    `https://power.larc.nasa.gov/api/temporal/hourly/point` +
    `?parameters=${POWER_PARAMS}&community=${community}` +
    `&longitude=${lon}&latitude=${lat}` +
    `&start=${start}&end=${end}&format=JSON&time-standard=UTC`
  );
}

/**
 * A POWER mede a pressão NA SUPERFÍCIE (PS, em kPa). Em montanhas ela parece "baixa pressão" só por causa da altitude.
 * Reduz ao nível do mar (fórmula barométrica padrão) para a camada de pressão mostrar sistemas de tempo, não relevo.
 */
export function toSeaLevelHpa(psKpa: number, tempC: number | null, elevationM: number): number {
  const ps = psKpa * 10;
  if (!elevationM || tempC === null) return ps;
  return ps * Math.pow(1 - (0.0065 * elevationM) / (tempC + 0.0065 * elevationM + 273.15), -5.257);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Resposta de um ponto da POWER → série no formato do globo. Devolve null se a resposta não tem dados. */
export function parsePowerPoint(res: any, lat: number, lon: number): PointSeries | null {
  const par = res?.properties?.parameter;
  if (!par?.T2M) return null;

  const elevation = Number(res?.geometry?.coordinates?.[2]) || 0;
  const keys = Object.keys(par.T2M).sort();          // 'AAAAMMDDHH'
  if (!keys.length) return null;

  const get = (name: string, k: string): number | null => {
    const v = par[name]?.[k];
    return typeof v === 'number' && v > POWER_FILL_LIMIT ? v : null;
  };

  const time = keys.map((k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}T${k.slice(8, 10)}:00`);
  const temperature_2m: (number | null)[] = [];
  const relative_humidity_2m: (number | null)[] = [];
  const pressure_msl: (number | null)[] = [];
  const wind_speed_10m: (number | null)[] = [];
  const wind_direction_10m: (number | null)[] = [];

  for (const k of keys) {
    const t = get('T2M', k);
    const rh = get('RH2M', k);
    const ps = get('PS', k);
    const ws = get('WS10M', k);
    const wd = get('WD10M', k);

    temperature_2m.push(t === null ? null : r1(t));
    relative_humidity_2m.push(rh === null ? null : r1(rh));
    pressure_msl.push(ps === null ? null : r1(toSeaLevelHpa(ps, t, elevation)));
    wind_speed_10m.push(ws === null ? null : r1(ws * 3.6));          // m/s → km/h
    wind_direction_10m.push(wd === null ? null : Math.round(wd));
  }

  return {
    latitude: lat,
    longitude: lon,
    hourly: { time, temperature_2m, relative_humidity_2m, pressure_msl, wind_speed_10m, wind_direction_10m },
  };
}

/**
 * A POWER atrasa alguns dias (tempo quase real): as últimas horas pedidas vêm como -999.
 * Corta todas as séries para a janela em que pelo menos `minShare` dos pontos têm dado.
 * Devolve null se nenhuma hora serve.
 */
export function trimToValidWindow(points: PointSeries[], minShare = 0.5): PointSeries[] | null {
  if (!points.length) return null;

  const axis = points[0].hourly.time;
  const same = points.filter((p) => p.hourly.time.length === axis.length);   // mesma janela de horas
  const need = Math.ceil(same.length * minShare);

  let first = -1, last = -1;
  for (let i = 0; i < axis.length; i++) {
    let ok = 0;
    for (const p of same) if (p.hourly.temperature_2m[i] !== null) ok++;
    if (ok >= need) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;

  return same.map((p) => {
    const h = p.hourly;
    return {
      latitude: p.latitude,
      longitude: p.longitude,
      hourly: {
        time: h.time.slice(first, last + 1),
        temperature_2m: h.temperature_2m.slice(first, last + 1),
        relative_humidity_2m: h.relative_humidity_2m.slice(first, last + 1),
        pressure_msl: h.pressure_msl.slice(first, last + 1),
        wind_speed_10m: h.wind_speed_10m.slice(first, last + 1),
        wind_direction_10m: h.wind_direction_10m.slice(first, last + 1),
      },
    };
  });
}