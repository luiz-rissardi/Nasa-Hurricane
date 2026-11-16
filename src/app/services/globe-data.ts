import { HttpClient } from '@angular/common/http';
import { inject, Service, signal } from '@angular/core';
import { EmptyError, firstValueFrom, forkJoin, Subject, takeUntil, timeout } from 'rxjs';
import { PointSeries, dateRangeUtc, parsePowerPoint, powerUrl, trimToValidWindow } from './nasa-power';

@Service()
export class GlobeData {


    private http = inject(HttpClient);
    private readonly cancelPrevious$ = new Subject<void>();

    /** Séries horárias da grade: um objeto por ponto, com os arrays em `hourly` (mesmo formato de antes). */
    private data = signal<any[]>([]);

    /** Horas disponíveis (epoch ms, UTC), na mesma ordem dos arrays de `hourly`. Vazio até os dados chegarem. */
    readonly timeline = signal<number[]>([]);

    /** Progresso da carga em andamento (a NASA POWER entrega um ponto por requisição). */
    readonly progress = signal({ done: 0, total: 0 });

    /**
     * Sobe (+1) quando a grade completa substitui a grade grossa que já estava na tela.
     * O componente refaz o campo nesse momento (a carga inicial não depende disso).
     */
    readonly refined = signal(0);

    /** true quando a carga falhou e não há dados para mostrar. */
    readonly failed = signal(false);

    private loading = false;
    private loadedAt = 0;
    private retryAfter = 0;   // não tenta a API de novo antes deste instante (backoff após erro)
    private runId = 0;        // cada carga nova cancela a anterior (as requisições pendentes são abandonadas)
    private latest = true;    // true = os dados na tela são os mais recentes; false = um dia antigo escolhido no filtro

    // ── Ajustes (mexa aqui) ───────────────────────────────────────────────────
    /**
     * Fonte da carga inicial:
     *  - 'open-meteo': UMA única requisição com os 264 pontos (o globo aparece na hora). A NASA POWER vira plano B automático.
     *  - 'nasa-power': 264 requisições (a POWER só aceita 1 ponto por requisição), em 2 etapas.
     */
    private readonly SOURCE: 'open-meteo' | 'nasa-power' = 'open-meteo';
    /** Open-Meteo: dias passados e futuros trazidos na mesma requisição (o filtro de hora anda por eles sem nova requisição). */
    private readonly OM_PAST_DAYS = 3;
    private readonly OM_FORECAST_DAYS = 3;

    /** Cada ponto da grade é UMA requisição à NASA POWER: grade maior = carga mais demorada. */
    private readonly GRID = { latMin: -75, latMax: 75, latStep: 15, lonMin: -180, lonMax: 165, lonStep: 15 };
    /** Carga inicial: pede os últimos N dias, porque a POWER atrasa e o dia de hoje ainda vem vazio (-999). */
    private readonly LATEST_DAYS_REQUESTED = 4;
    /** ...e mantém só as últimas N horas com dado (1 dia). */
    private readonly LATEST_HOURS_KEPT = 24;
    /** Requisições simultâneas: a documentação da POWER pede no máximo 5 ("it may block your access"). */
    private readonly CONCURRENCY = 5;
    /** Carga em 2 etapas: primeiro 1 ponto a cada COARSE (na grade), que já mostra o globo; depois o resto, em segundo plano. */
    private readonly COARSE = 2;
    /** Quantas vezes repete um ponto que recebeu 429 (limite de requisições) antes de desistir. */
    private readonly MAX_RATE_LIMIT_RETRIES = 5;

    private readonly REFRESH_MS = 60 * 60 * 1000;
    private readonly RETRY_MS = 30 * 1000;
    private readonly REQUEST_TIMEOUT_MS = 30000;
    private readonly RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;   // após um 429, espera 10 min

    /**
     * Dados do globo para a hora mais recente disponível (formato `current`, o mesmo de antes).
     * Também dispara a atualização quando os dados vencem (só se a tela está nos dados mais recentes).
     */
    getData(): any[] {
        const now = Date.now();
        if (this.latest && !this.loading && now - this.loadedAt > this.REFRESH_MS && now > this.retryAfter) {
            void this.loadGlobalData();
        }
        return this.getDataAt(this.nowIndex());
    }

    /** true quando os dados na tela são os mais recentes (e não um dia antigo escolhido no filtro). */
    isLatest(): boolean {
        return this.latest;
    }

    /** Índice (em `timeline`) da hora atual, limitado ao que foi baixado: com a POWER, é a última hora disponível. */
    nowIndex(): number {
        const tl = this.timeline();
        if (!tl.length) return 0;
        const i = Math.round((Math.floor(Date.now() / 3600000) * 3600000 - tl[0]) / 3600000);
        return Math.min(Math.max(i, 0), tl.length - 1);
    }

    /**
     * Dados do globo inteiro para a hora `i` da `timeline`, no formato que o campo de vento já consome
     * (um objeto por ponto, com `latitude`, `longitude` e `current`). Não faz requisição.
     */
    getDataAt(i: number): any[] {
        const raw = this.data();
        if (!raw.length) return [];
        return raw.map((loc) => {
            const h = loc.hourly;
            return {
                latitude: loc.latitude,
                longitude: loc.longitude,
                current: {
                    temperature_2m: h.temperature_2m?.[i],
                    relative_humidity_2m: h.relative_humidity_2m?.[i],
                    pressure_msl: h.pressure_msl?.[i],
                    wind_speed_10m: h.wind_speed_10m?.[i],
                    wind_direction_10m: h.wind_direction_10m?.[i],
                },
            };
        });
    }

    private apply(list: any[], latest: boolean): void {
        // As horas vêm em UTC: "2026-11-15T14:00" é 14:00 UTC
        this.timeline.set((list[0].hourly.time as string[]).map((t) => Date.parse(t + 'Z')));
        this.data.set(list);
        this.latest = latest;
        this.failed.set(false);
    }

    /** Fica só com as últimas `n` horas de cada ponto. */
    private lastHours(list: PointSeries[], n: number): PointSeries[] {
        return list.map((p) => {
            const h: any = {};
            for (const k of Object.keys(p.hourly)) h[k] = (p.hourly as any)[k].slice(-n);
            return { ...p, hourly: h };
        });
    }

    private ymdUtc(ms: number): string {
        return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
    }

    /**
     * Variações do pedido, tentadas em ordem quando a POWER recusa (400/422): comunidade (RE é a dos exemplos oficiais)
     * e data final recuada (caso ela rejeite uma data final além do último dado publicado).
     * A que funcionar passa a valer para todos os pontos.
     */
    private readonly VARIANTS = [
        { community: 'RE', back: 0 }, { community: 'SB', back: 0 }, { community: 'AG', back: 0 },
        { community: 'RE', back: 1 }, { community: 'RE', back: 2 }, { community: 'SB', back: 1 }, { community: 'SB', back: 2 },
    ];
    private variantIdx = 0;

    /** Recua a data final (AAAAMMDD) em `days` dias, sem ficar antes da inicial. */
    private shiftEnd(start: string, end: string, days: number): string {
        if (!days) return end;
        const t = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
        return this.ymdUtc(Math.max(t(end) - days * 86400000, t(start)));
    }

    /** Texto curto do erro, para a mensagem final e o console. */
    private describeError(e: any): string {
        if (e?.name === 'TimeoutError') return `tempo esgotado (${this.REQUEST_TIMEOUT_MS / 1000} s sem resposta)`;
        const msg = e?.error?.messages ?? e?.error?.message ?? (typeof e?.error === 'string' ? e.error : '');
        if (e?.status === 0) return 'sem resposta do servidor (rede, bloqueio do navegador/CORS ou VPN/antivírus)';
        if (e?.status) return `HTTP ${e.status}${msg ? ' – ' + (Array.isArray(msg) ? msg.join('; ') : msg) : ''}`;
        return e?.message ?? String(e);
    }

    // Controle de ritmo: depois de um 429 todos os workers esperam e as próximas requisições saem mais espaçadas
    private pauseUntil = 0;
    private gapMs = 0;
    private nextSlot = 0;

    private sleep(ms: number): Promise<void> {
        return new Promise((r) => setTimeout(r, ms));
    }

    /** Espera a pausa por 429 acabar e respeita o espaçamento mínimo entre inícios de requisição. */
    private async acquireSlot(): Promise<void> {
        while (Date.now() < this.pauseUntil) await this.sleep(Math.min(500, this.pauseUntil - Date.now()));
        const now = Date.now();
        const at = Math.max(now, this.nextSlot);
        this.nextSlot = at + this.gapMs;
        if (at > now) await this.sleep(at - now);
    }

    /**
     * Uma requisição à POWER. Repete sozinha: 429 (espera o Retry-After, ou alguns segundos, e todos os workers
     * param junto), recusa de parâmetro (próxima variação) e falha de rede passageira (1 nova tentativa).
     * Devolve null se a carga foi cancelada. Lança o erro se não der.
     */
    private async fetchPoint(lat: number, lon: number, start: string, end: string, run: number): Promise<PointSeries | null> {
        let rateRetries = 0, netRetried = false;

        while (true) {
            if (run !== this.runId) return null;
            await this.acquireSlot();
            if (run !== this.runId) return null;

            const used = this.variantIdx;
            const v = this.VARIANTS[used];
            try {
                const res = await firstValueFrom(
                    this.http.get<any>(powerUrl(lat, lon, start, this.shiftEnd(start, end, v.back), v.community)).pipe(timeout(this.REQUEST_TIMEOUT_MS)));
                this.gapMs = this.gapMs < 60 ? 0 : Math.floor(this.gapMs * 0.7);   // com respostas boas, volta ao ritmo normal
                return parsePowerPoint(res, lat, lon);
            } catch (e: any) {
                const status = e?.status;

                if (status === 429 || status === 503) {
                    if (rateRetries++ >= this.MAX_RATE_LIMIT_RETRIES) throw e;
                    const header = Number(e?.headers?.get?.('Retry-After'));
                    const wait = header > 0 ? header * 1000 : 4000 * rateRetries;
                    if (Date.now() >= this.pauseUntil) this.gapMs = Math.min(2000, this.gapMs ? this.gapMs * 2 : 400);   // só 1× por "rajada" de 429
                    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + wait);
                    continue;
                }

                if ((status === 400 || status === 422) && used < this.VARIANTS.length - 1) {
                    if (this.variantIdx === used) {
                        this.variantIdx = used + 1;
                        const n = this.VARIANTS[used + 1];
                        console.warn(`[GlobeData] NASA POWER recusou (${this.describeError(e)}) com community=${v.community}, data final -${v.back}d → tentando community=${n.community}, data final -${n.back}d`);
                    }
                    continue;
                }

                if (!netRetried && !(status >= 400 && status < 500)) {
                    netRetried = true;
                    await this.sleep(700);
                    continue;
                }
                throw e;
            }
        }
    }

    /**
     * Baixa a grade inteira (um ponto por requisição) para o intervalo [start, end] (AAAAMMDD, UTC).
     * Os pontos da grade grossa vão primeiro; quando eles terminam, `onPartial` recebe o que chegou
     * (a tela já pode mostrar o globo) e o resto continua sendo baixado.
     */
    private async fetchGrid(start: string, end: string, run: number, onPartial?: (ok: PointSeries[], n: number) => void) {
        const g = this.GRID;
        const coarse: { lat: number; lon: number }[] = [];
        const fine: { lat: number; lon: number }[] = [];
        for (let la = 0, lat = g.latMin; lat <= g.latMax; la++, lat += g.latStep) {
            for (let lo = 0, lon = g.lonMin; lon <= g.lonMax; lo++, lon += g.lonStep) {
                (la % this.COARSE === 0 && lo % this.COARSE === 0 ? coarse : fine).push({ lat, lon });
            }
        }
        const points = [...coarse, ...fine];
        const nCoarse = coarse.length;

        const results: (PointSeries | null)[] = new Array(points.length).fill(null);
        let next = 0, done = 0, coarseDone = 0, okCount = 0, rateLimited = false, aborted = false;
        let lastError = '';
        const FAIL_FAST = 10;   // se as 10 primeiras respostas falham (sem 429), é erro de configuração/rede: não adianta tentar as 264
        this.progress.set({ done: 0, total: points.length });

        const worker = async () => {
            while (!rateLimited && !aborted && run === this.runId) {
                const i = next++;
                if (i >= points.length) return;
                try {
                    results[i] = await this.fetchPoint(points[i].lat, points[i].lon, start, end, run);
                    if (results[i]) okCount++;
                } catch (e: any) {
                    lastError = this.describeError(e);
                    if (e?.status === 429 || e?.status === 503) rateLimited = true;
                    else if (done < 3) console.warn('[GlobeData] ponto falhou:', points[i], lastError);
                    if (!okCount && done + 1 >= FAIL_FAST && !rateLimited) aborted = true;
                }
                if (run !== this.runId) return;
                this.progress.set({ done: ++done, total: points.length });

                if (i < nCoarse && ++coarseDone === nCoarse && onPartial && nCoarse < points.length) {
                    onPartial(results.slice(0, nCoarse).filter((r): r is PointSeries => r !== null), nCoarse);
                }
            }
        };
        await Promise.all(Array.from({ length: this.CONCURRENCY }, worker));

        return { ok: results.filter((r): r is PointSeries => r !== null), total: points.length, rateLimited, lastError };
    }

    /** Pontos da grade (lat/lon). */
    private gridPoints(): { lat: number; lon: number }[] {
        const g = this.GRID;
        const pts: { lat: number; lon: number }[] = [];
        for (let lat = g.latMin; lat <= g.latMax; lat += g.latStep) {
            for (let lon = g.lonMin; lon <= g.lonMax; lon += g.lonStep) pts.push({ lat, lon });
        }
        return pts;
    }

    /**
     * UMA requisição para o globo inteiro: o Open-Meteo aceita todas as coordenadas na mesma chamada e devolve,
     * para cada uma, as séries horárias (horas em UTC). Mesmo formato interno da NASA POWER.
     * Devolve true se aplicou os dados; false se falhou (aí entra o plano B).
     */
    private async tryOpenMeteo(run: number): Promise<boolean> {
        const pts = this.gridPoints();
        const url = 'https://api.open-meteo.com/v1/forecast' +
            `?latitude=${pts.map((p) => p.lat).join(',')}&longitude=${pts.map((p) => p.lon).join(',')}` +
            '&hourly=temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m' +
            `&wind_speed_unit=kmh&timezone=GMT&past_days=${this.OM_PAST_DAYS}&forecast_days=${this.OM_FORECAST_DAYS}`;

        this.progress.set({ done: 0, total: 1 });
        try {
            const res = await firstValueFrom(this.http.get<any>(url).pipe(timeout(this.REQUEST_TIMEOUT_MS)));
            if (run !== this.runId) return false;

            const list = (Array.isArray(res) ? res : [res])
                .filter((r: any) => r?.hourly?.time?.length && r.hourly.temperature_2m)
                .map((r: any) => ({ latitude: r.latitude, longitude: r.longitude, hourly: r.hourly }));
            if (list.length < pts.length * 0.5) throw new Error(`resposta com só ${list.length} de ${pts.length} pontos`);

            console.log(`[GlobeData] Open-Meteo (1 requisição): ${list.length} pontos × ${list[0].hourly.time.length} horas`);
            this.progress.set({ done: 1, total: 1 });
            this.apply(list, true);
            this.loadedAt = Date.now();
            return true;
        } catch (e: any) {
            if (run === this.runId) {
                console.warn(`[GlobeData] Open-Meteo falhou (${this.describeError(e)}). Usando o plano B: NASA POWER (264 requisições).`);
            }
            return false;
        }
    }

    /** Carga dos dados mais recentes. Sem cache. */
    private async loadGlobalData(): Promise<void> {
        const run = ++this.runId;
        this.loading = true;
        let rateLimited = false;
        let partialApplied = false;
        if (!this.data().length) this.failed.set(false);   // nova tentativa: a tela volta a mostrar "carregando"

        try {
            // Caminho rápido: tudo em uma requisição
            if (this.SOURCE === 'open-meteo') {
                const ok = await this.tryOpenMeteo(run);
                if (run !== this.runId || ok) return;
            }

            // NASA POWER (fonte principal se SOURCE = 'nasa-power', ou plano B)
            const yesterday = Math.floor(Date.now() / 86400000) * 86400000 - 86400000;
            const { start, end } = dateRangeUtc(this.LATEST_DAYS_REQUESTED, yesterday);   // termina ontem (UTC)

            // Etapa 1: a grade grossa já mostra o globo
            const r = await this.fetchGrid(start, end, run, (okPart, n) => {
                if (run !== this.runId || okPart.length < n * 0.5) return;
                const valid = trimToValidWindow(okPart);
                if (!valid) return;
                const list = this.lastHours(valid, this.LATEST_HOURS_KEPT);
                console.log(`[GlobeData] NASA POWER (etapa 1): ${list.length} pontos × ${list[0].hourly.time.length} horas`);
                this.apply(list, true);
                this.loadedAt = Date.now();
                partialApplied = true;
            });
            if (run !== this.runId) return;   // outra carga assumiu

            rateLimited = r.rateLimited;
            if (rateLimited) this.retryAfter = Date.now() + this.RATE_LIMIT_BACKOFF_MS;

            // Etapa 2: a grade completa substitui a grossa (se falhou, a grossa que já está na tela continua)
            const valid = r.ok.length >= r.total * 0.5 ? trimToValidWindow(r.ok) : null;
            if (!valid) {
                if (partialApplied) { console.warn('[GlobeData] grade completa incompleta: mantendo a grade grossa'); return; }
                if (r.ok.length < r.total * 0.5) throw new Error(`Só ${r.ok.length} de ${r.total} pontos responderam. Motivo: ${r.lastError || (rateLimited ? 'limite de requisições (HTTP 429)' : 'resposta sem dados')}`);
                throw new Error('A NASA POWER não devolveu nenhuma hora com dados na janela pedida');
            }

            const list = this.lastHours(valid, this.LATEST_HOURS_KEPT);
            console.log(`[GlobeData] NASA POWER: ${list.length} pontos × ${list[0].hourly.time.length} horas ` +
                `(${list[0].hourly.time[0]} → ${list[0].hourly.time.at(-1)})`);
            this.apply(list, true);
            this.loadedAt = Date.now();
            if (partialApplied) this.refined.update((v) => v + 1);
        } catch (e: any) {
            console.error('[GlobeData] falhou:', e?.message ?? e);
            if (!rateLimited) this.retryAfter = Date.now() + this.RETRY_MS;
            if (!this.data().length) this.failed.set(true);   // com dados já na tela, eles continuam
        } finally {
            if (run === this.runId) this.loading = false;
        }
    }

    /**
     * Baixa o dia escolhido no filtro (data local 'AAAA-MM-DD'): sem limite para trás.
     * Pede o dia UTC anterior, o do dia e o seguinte, para cobrir qualquer fuso. Devolve false se falhar.
     */
    async loadAround(ymd: string): Promise<boolean> {
        const [y, m, d] = ymd.split('-').map(Number);
        const DAY = 86400000;
        const day = Date.UTC(y, m - 1, d);
        const lastDay = Math.floor(Date.now() / DAY) * DAY - DAY;   // ontem (UTC): hoje a POWER ainda não tem
        const start = this.ymdUtc(Math.min(day - DAY, lastDay));
        const end = this.ymdUtc(Math.min(day + DAY, lastDay));

        const run = ++this.runId;
        this.loading = true;

        // Resolve assim que a grade grossa chega (o dia já aparece); a grade completa continua em segundo plano
        return new Promise<boolean>((resolve) => {
            let settled = false, partialApplied = false;
            const settle = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };

            (async () => {
                try {
                    const r = await this.fetchGrid(start, end, run, (okPart, n) => {
                        if (run !== this.runId || okPart.length < n * 0.5) return;
                        const list = trimToValidWindow(okPart);
                        if (!list) return;
                        this.apply(list, false);
                        partialApplied = true;
                        settle(true);
                    });
                    if (run !== this.runId) { settle(false); return; }

                    if (r.rateLimited) this.retryAfter = Date.now() + this.RATE_LIMIT_BACKOFF_MS;

                    const list = r.ok.length >= r.total * 0.5 ? trimToValidWindow(r.ok) : null;
                    if (!list) {
                        if (!partialApplied) console.error(`[GlobeData] não foi possível baixar o dia ${ymd}. Motivo: ${r.lastError || 'resposta sem dados'}`);
                        settle(partialApplied);
                        return;
                    }

                    this.apply(list, false);
                    if (partialApplied) this.refined.update((v) => v + 1);
                    settle(true);
                } catch (e: any) {
                    console.error('[GlobeData] falhou ao baixar o dia', ymd, e?.message ?? e);
                    settle(partialApplied);
                } finally {
                    if (run === this.runId) this.loading = false;
                }
            })();
        });
    }

    /** Volta para os dados mais recentes. Devolve true se a tela ficou nos dados mais recentes. */
    async loadLatest(): Promise<boolean> {
        if (this.latest && this.data().length && Date.now() - this.loadedAt < this.REFRESH_MS) return true;
        await this.loadGlobalData();
        return this.latest;
    }


    /** Retorna os dados, ou null se esta chamada foi cancelada por uma mais nova. */
    async getWeatherDataAndAstronomy(lat: number, lon: number) {
        // Cancela a chamada anterior (se ainda estiver em andamento) antes de começar a nova
        this.cancelPrevious$.next();

        const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m&hourly=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m&daily=sunrise,sunset,moonrise,moonset,moon_phase&timezone=auto`;
        const airQualityUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi,pm2_5,pm10,nitrogen_dioxide&timezone=auto`;

        try {
            const [data, airData]: any = await firstValueFrom(
                forkJoin([this.http.get(weatherUrl), this.http.get(airQualityUrl)]).pipe(
                    takeUntil(this.cancelPrevious$)   // uma nova chamada derruba esta
                )
            );

            // Encontra o índice exato da hora atual correspondente ao fuso horário local da coordenada
            const nowIsoString = new Date().toISOString().slice(0, 13); // ex: "2026-11-14T21"
            let currentIndex = data.hourly.time.findIndex((t: string) => t.startsWith(nowIsoString));

            // Fallback de segurança caso não ache a string exata
            if (currentIndex === -1) currentIndex = 0;

            const next24Hours = [];
            for (let i = 0; i < 24; i++) {
                const index = currentIndex + i;
                if (data.hourly.time[index]) {
                    next24Hours.push({
                        horario: data.hourly.time[index],
                        temperatura: data.hourly.temperature_2m[index],
                        umidade: data.hourly.relative_humidity_2m[index],
                        precipitacao: data.hourly.precipitation[index],
                        velocidadeVento: data.hourly.wind_speed_10m[index],
                        direcaoVento: data.hourly.wind_direction_10m[index]
                    });
                }
            }

            return {
                clima: {
                    temperatura: data.current.temperature_2m,
                    umidade: data.current.relative_humidity_2m,
                    pressao: data.current.surface_pressure,
                    velocidadeVento: data.current.wind_speed_10m,
                    direcaoVento: data.current.wind_direction_10m
                },
                astronomia: {
                    nascerSol: data.daily.sunrise[0],
                    porSol: data.daily.sunset[0],
                    nascerLua: data.daily.moonrise[0] ? data.daily.moonrise[0] : 'Não visível hoje',
                    porLua: data.daily.moonset[0] ? data.daily.moonset[0] : 'Não visível hoje',
                    faseLua: data.daily.moon_phase[0]
                },
                hourly: next24Hours,
                qualidadeAr: {
                    aqi: airData.current.european_aqi,
                    pm25: airData.current.pm2_5,
                    pm10: airData.current.pm10,
                    no2: airData.current.nitrogen_dioxide
                }
            };
        } catch (error) {
            // takeUntil completou sem emitir valor: foi cancelada por uma chamada mais nova (não é erro)
            if (error instanceof EmptyError) return null;

            console.error('Erro ao buscar dados:', error);
            throw error;
        }
    }
}