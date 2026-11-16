import { inject, Service, signal } from '@angular/core';
import { GlobeData } from '../services/globe-data';

/**
 * Porta de entrada dos componentes para os dados do tempo:
 *  - globo inteiro, hora a hora (campo de vento, temperatura e pressão);
 *  - detalhes do ponto clicado (clima, astronomia, próximas 24 h e qualidade do ar).
 */
@Service()
export class GlobeFacade {
    private globeData = inject(GlobeData);

    // ───────────── Globo inteiro (uma requisição, todas as horas) ─────────────

    /** Horas disponíveis (epoch ms, UTC). Vazio até os dados chegarem. */
    readonly timeline = this.globeData.timeline;
    /** Progresso da carga inicial (a NASA POWER entrega um ponto por requisição). */
    readonly loadProgress = this.globeData.progress;
    readonly dataVersion = this.globeData.refined;
    /** true quando a carga falhou e não há dados para mostrar. */
    readonly loadFailed = this.globeData.failed;

    /** Dados da hora atual; também dispara a atualização quando os dados vencem. */
    getData(): any[] {
        return this.globeData.getData();
    }

    /** Dados da hora `i` da timeline (sem requisição). */
    getDataAt(i: number): any[] {
        return this.globeData.getDataAt(i);
    }

    /** Baixa o dia escolhido no filtro (data local 'AAAA-MM-DD'). Devolve false se falhar. */
    loadAround(ymd: string): Promise<boolean> {
        return this.globeData.loadAround(ymd);
    }

    /** Volta para os dados mais recentes. */
    loadLatest(): Promise<boolean> {
        return this.globeData.loadLatest();
    }

    /** true quando a tela está nos dados mais recentes (e não num dia antigo). */
    isLatest(): boolean {
        return this.globeData.isLatest();
    }

    /** Índice da hora atual na timeline. */
    nowIndex(): number {
        return this.globeData.nowIndex();
    }

    // ───────────── Ponto clicado no globo ─────────────

    readonly selectedWeather = signal<any | null>(null);
    readonly selectedAstronomy = signal<any | null>(null);
    readonly selectedHourly = signal<any[]>([]);
    readonly selectedAirQuality = signal<any | null>(null);
    readonly loadingPoint = signal(false);
    readonly pointError = signal<string | null>(null);

    private pointRequestId = 0;

    /** Busca os detalhes de uma coordenada. Um clique novo cancela o anterior (veja GlobeData). */
    async getWeatherDataOfCoord(lat: number, lon: number): Promise<void> {
        // Clique antes de o mouse passar sobre o globo: ainda não há coordenada
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const id = ++this.pointRequestId;
        this.loadingPoint.set(true);
        this.pointError.set(null);

        try {
            const result = await this.globeData.getWeatherDataAndAstronomy(lat, lon);

            // null = cancelada por uma chamada mais nova; id diferente = resposta velha
            if (!result || id !== this.pointRequestId) return;

            this.selectedWeather.set(result.clima);
            this.selectedAstronomy.set(result.astronomia);
            this.selectedHourly.set(result.hourly);
            this.selectedAirQuality.set(result.qualidadeAr);
        } catch (e: any) {
            if (id === this.pointRequestId) {
                this.pointError.set(e?.status === 429
                    ? 'Limite diário da API atingido. Tente novamente mais tarde.'
                    : 'Não foi possível buscar os dados deste ponto.');
            }
        } finally {
            if (id === this.pointRequestId) this.loadingPoint.set(false);
        }
    }
}