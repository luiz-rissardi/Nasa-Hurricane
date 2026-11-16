import { ChangeDetectionStrategy, Component, DestroyRef, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { fetchClimate, VarKey } from './nasa-climate';
import {
  annualAnomalies, Current, currentState, Level, linearTrend, monthlyNormal, Trend, trendLine, YearAnomaly,
} from './trend-math';

interface Bar { x: number; y: number; w: number; h: number; up: boolean; year: number; value: string }

interface Card {
  key: VarKey;
  label: string;
  icon: string;
  unit: string;          // °C, %, hPa
  digits: number;
  current: Current | null;
  trend: Trend | null;
  bars: Bar[];
  line: { x1: number; y1: number; x2: number; y2: number } | null;
  from: number;
  to: number;
  gauge: number;         // 0..100, posição do z-score na barra
}

const VARS: { key: VarKey; label: string; icon: string; unit: string; digits: number }[] = [
  { key: 'temperature', label: 'Temperature', icon: '🌡️', unit: '°C', digits: 1 },
  { key: 'humidity', label: 'Humidity', icon: '💧', unit: '%', digits: 1 },
  { key: 'pressure', label: 'Pressure', icon: '🧭', unit: 'hPa', digits: 1 },
];

const PRESETS = [
  { name: 'Curitiba', lat: -25.43, lon: -49.27 },
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'Sahara', lat: 23.4, lon: 12.0 },
  { name: 'Arctic', lat: 78.2, lon: 15.6 },
];

const LEVEL_TEXT: Record<Level, string> = {
  'far-below': 'Far below normal',
  below: 'Below normal',
  normal: 'Within the normal range',
  above: 'Above normal',
  'far-above': 'Far above normal',
};

// SVG do gráfico
const W = 320, H = 120, PAD_X = 6, PAD_Y = 8;

// Evita pedir de novo o mesmo ponto (a grade da NASA tem ~0,5°, então arredondar não muda o resultado)
const cache = new Map<string, ReturnType<typeof fetchClimate>>();

@Component({
  selector: 'app-trends',
  imports: [RouterLink],
  templateUrl: './trend.html',
  styleUrl: './trend.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Trends implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private destroyRef = inject(DestroyRef);
  private abort?: AbortController;

  protected readonly presets = PRESETS;
  protected readonly viewBox = `0 0 ${W} ${H}`;
  protected readonly zeroY = H / 2;

  protected readonly lat = signal(PRESETS[0].lat);
  protected readonly lon = signal(PRESETS[0].lon);
  protected readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal('');
  protected readonly cards = signal<Card[]>([]);

  /** Frase-resumo, baseada na temperatura (a variável que as pessoas mais entendem). */
  protected readonly headline = computed(() => {
    const t = this.cards().find((c) => c.key === 'temperature');
    if (!t?.current) return '';
    const parts = [`${LEVEL_TEXT[t.current.level]} for temperature right now (${this.signed(t.current.anomaly, 1)} °C vs. 1991–2020)`];
    if (t.trend) {
      parts.push(
        t.trend.verdict === 'stable'
          ? 'with no clear long-term trend since 1981'
          : `and it has been ${t.trend.verdict === 'rising' ? 'rising' : 'falling'} ${this.signed(t.trend.slopePerDecade, 2)} °C per decade since 1981`,
      );
    }
    return parts.join(', ') + '.';
  });

  ngOnInit(): void {
    // ?lat=..&lon=.. (vindos do globo). Emite já na assinatura e de novo se a URL mudar com a tela aberta.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
      if (q.has('lat') && q.has('lon') && this.valid(lat, lon)) {
        this.lat.set(lat);
        this.lon.set(lon);
      }
      this.load();
    });
  }

  ngOnDestroy(): void {
    this.abort?.abort();
  }

  protected analyze(latText: string, lonText: string): void {
    const lat = Number(latText.replace(',', '.')), lon = Number(lonText.replace(',', '.'));
    if (!this.valid(lat, lon) || !latText.trim() || !lonText.trim()) {
      this.status.set('error');
      this.error.set('Enter a latitude between −90 and 90 and a longitude between −180 and 180.');
      return;
    }
    this.lat.set(lat);
    this.lon.set(lon);
    this.load();
  }

  protected usePreset(p: { lat: number; lon: number }): void {
    this.lat.set(p.lat);
    this.lon.set(p.lon);
    this.load();
  }

  protected signed(v: number, digits: number): string {
    const s = v.toFixed(digits);
    if (Number(s) === 0) return s.replace('-', '');          // evita "-0.0"
    return v > 0 ? `+${s}` : s.replace('-', '−');
  }

  protected levelText(l: Level): string {
    return LEVEL_TEXT[l];
  }

  protected verdictText(t: Trend): string {
    return t.verdict === 'rising' ? 'Rising' : t.verdict === 'falling' ? 'Falling' : 'No clear trend';
  }

  private valid(lat: number, lon: number): boolean {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    const ctl = (this.abort = new AbortController());
    this.status.set('loading');
    this.error.set('');

    const lat = this.lat(), lon = this.lon();
    const key = `${(Math.round(lat * 2) / 2).toFixed(1)},${(Math.round(lon * 2) / 2).toFixed(1)}`;

    try {
      let req = cache.get(key);
      if (!req) {
        req = fetchClimate(lat, lon);
        cache.set(key, req);
        req.catch(() => cache.delete(key));          // falhou: deixa tentar de novo
      }
      const { monthly, daily } = await req;
      if (ctl.signal.aborted) return;

      const cards: Card[] = [];
      for (const v of VARS) {
        const normal = monthlyNormal(monthly, v.key);
        if (!normal) continue;
        const series = annualAnomalies(monthly, v.key, normal);
        cards.push({
          ...v,
          current: currentState(daily, v.key, normal),
          trend: linearTrend(series),
          ...this.chart(series, v.digits),
          from: series[0]?.year ?? 0,
          to: series[series.length - 1]?.year ?? 0,
          gauge: 50,
        });
        const c = cards[cards.length - 1];
        if (c.current) c.gauge = Math.min(100, Math.max(0, ((c.current.z + 3) / 6) * 100));
      }

      if (!cards.length) throw new Error('Not enough historical data for this location.');
      this.cards.set(cards);
      this.status.set('ready');
    } catch (e: any) {
      if (ctl.signal.aborted) return;
      this.status.set('error');
      this.error.set(
        e?.status === 429
          ? 'NASA POWER is limiting requests right now. Wait a minute and try again.'
          : e?.message?.startsWith('Not enough')
            ? e.message
            : 'Could not get data from NASA POWER. Check your connection and try again.',
      );
    }
  }

  /** Barras da anomalia anual (acima de zero = mais quente/úmido/alto que a normal) + reta de tendência. */
  private chart(series: YearAnomaly[], digits: number): Pick<Card, 'bars' | 'line'> {
    if (!series.length) return { bars: [], line: null };

    const max = Math.max(...series.map((p) => Math.abs(p.value)), 1e-6) * 1.1;
    const y = (v: number) => H / 2 - (v / max) * (H / 2 - PAD_Y);
    const x0 = series[0].year, x1 = series[series.length - 1].year;
    const span = Math.max(1, x1 - x0);
    const step = (W - 2 * PAD_X) / (span + 1);
    const xOf = (yr: number) => PAD_X + (yr - x0) * step;

    const bars = series.map<Bar>((p) => {
      const top = y(Math.max(p.value, 0)), bottom = y(Math.min(p.value, 0));
      return {
        x: xOf(p.year), y: top, w: Math.max(1, step * 0.78), h: Math.max(0.5, bottom - top),
        up: p.value >= 0, year: p.year, value: this.signed(p.value, digits + 1),
      };
    });

    const tl = trendLine(series);
    return {
      bars,
      line: tl && { x1: xOf(tl.x0) + step / 2, y1: y(tl.y0), x2: xOf(tl.x1) + step / 2, y2: y(tl.y1) },
    };
  }
}