import { DailyPoint, MonthlyGrid, NORMAL_FROM, NORMAL_TO, VarKey } from './nasa-climate';

/**
 * Matemática das tendências (sem Angular, sem rede).
 *
 *  normal(mês)    = média do mês nos anos 1991-2020 (e o desvio-padrão, para dizer o quão "fora do normal" algo está)
 *  anomalia       = valor − normal do mesmo mês  (tira a sazonalidade, sobra só o desvio)
 *  tendência      = reta de mínimos quadrados sobre a anomalia ANUAL (°C/década, hPa/década, %/década)
 *  significância  = estatística t da inclinação; |t| ≥ ~2 ⇒ a tendência é distinguível do ruído (≈95 %)
 */

export interface Normal { mean: number[]; sd: number[] }   // 12 posições (jan..dez)

export interface Trend {
  slopePerDecade: number;
  t: number;               // estatística t da inclinação
  r2: number;
  n: number;               // anos usados
  verdict: 'rising' | 'falling' | 'stable';
}

export interface YearAnomaly { year: number; value: number }

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[], m = mean(a)) => Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1));

/** Normal e desvio de cada mês do calendário no período 1991-2020. */
export function monthlyNormal(grid: MonthlyGrid, key: VarKey): Normal | null {
  const mean12: number[] = [], sd12: number[] = [];
  for (let m = 0; m < 12; m++) {
    const xs: number[] = [];
    for (let y = NORMAL_FROM; y <= NORMAL_TO; y++) {
      const v = grid[key].get(y)?.[m];
      if (typeof v === 'number') xs.push(v);
    }
    if (xs.length < 20) return null;                       // menos de 20 dos 30 anos: normal não confiável
    const mu = mean(xs);
    mean12.push(mu);
    sd12.push(sd(xs, mu));
  }
  return { mean: mean12, sd: sd12 };
}

/** Anomalia anual = média das 12 anomalias mensais. Anos com algum mês sem dado são descartados. */
export function annualAnomalies(grid: MonthlyGrid, key: VarKey, normal: Normal): YearAnomaly[] {
  const out: YearAnomaly[] = [];
  for (const [year, months] of [...grid[key].entries()].sort((a, b) => a[0] - b[0])) {
    if (months.some((v) => v === null)) continue;
    out.push({ year, value: mean(months.map((v, m) => (v as number) - normal.mean[m])) });
  }
  return out;
}

/** Regressão linear anomalia × ano. Precisa de pelo menos 10 anos. */
export function linearTrend(series: YearAnomaly[]): Trend | null {
  const n = series.length;
  if (n < 10) return null;

  const xs = series.map((p) => p.year), ys = series.map((p) => p.value);
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;

  const se = Math.sqrt(sse / (n - 2) / sxx);
  const t = se > 0 ? slope / se : slope === 0 ? 0 : Infinity * Math.sign(slope);
  const r2 = syy > 0 ? 1 - sse / syy : 0;

  return {
    slopePerDecade: slope * 10,
    t,
    r2,
    n,
    verdict: Math.abs(t) < 2 ? 'stable' : slope > 0 ? 'rising' : 'falling',
  };
}

/** Pontos da reta para desenhar (primeiro e último ano). */
export function trendLine(series: YearAnomaly[]): { x0: number; y0: number; x1: number; y1: number } | null {
  const tr = linearTrend(series);
  if (!tr) return null;
  const slope = tr.slopePerDecade / 10;
  const mx = mean(series.map((p) => p.year)), my = mean(series.map((p) => p.value));
  const x0 = series[0].year, x1 = series[series.length - 1].year;
  return { x0, y0: my + slope * (x0 - mx), x1, y1: my + slope * (x1 - mx) };
}

export type Level = 'far-below' | 'below' | 'normal' | 'above' | 'far-above';

export interface Current {
  value: number;          // média dos últimos dias com dado
  normal: number;         // normal para os mesmos dias do calendário
  anomaly: number;
  z: number;              // anomalia ÷ desvio típico (variação entre anos do mês)
  level: Level;
  days: number;           // quantos dias entraram na média
  until: string;          // 'AAAA-MM-DD' do último dia com dado
}

export function levelOf(z: number): Level {
  return z <= -2 ? 'far-below' : z <= -1 ? 'below' : z < 1 ? 'normal' : z < 2 ? 'above' : 'far-above';
}

/**
 * Estado atual: média dos últimos `window` dias COM dado (a POWER atrasa uns dias) contra a normal
 * dos meses a que esses dias pertencem (ponderada pelos dias de cada mês).
 * O z usa o desvio entre anos do mês: é uma aproximação — a média de 30 dias varia de forma parecida com a média mensal.
 */
export function currentState(daily: DailyPoint[], key: VarKey, normal: Normal, window = 30): Current | null {
  const valid = daily.filter((d) => d[key] !== null);
  const last = valid.slice(-window);
  if (last.length < 7) return null;                         // pouco dado recente: não conclui nada

  let nSum = 0, sdSum = 0;
  for (const d of last) {
    const m = Number(d.day.slice(4, 6)) - 1;
    nSum += normal.mean[m];
    sdSum += normal.sd[m];
  }
  const value = mean(last.map((d) => d[key] as number));
  const nrm = nSum / last.length;
  const spread = sdSum / last.length;
  const anomaly = value - nrm;
  const z = spread > 0 ? anomaly / spread : 0;
  const u = last[last.length - 1].day;

  return { value, normal: nrm, anomaly, z, level: levelOf(z), days: last.length, until: `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}` };
}