import {
  AfterViewInit,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  PLATFORM_ID
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GlobeFacade } from '../../facades/globe-facade';
import { InfoGram } from '../info-gram/info-gram';
import { TemperatureLegend } from '../temperature-legend/temperature-legend';
import {
  TEMP_RANGE,
  TEMP_INV_RANGE,
  temperatureLut,
  particleTempColor,
  temperatureGradientCss,
  temperatureLegendTicks,
  temperatureLegendBands,
} from './temperature-scale';
import {
  PRESSURE_RANGE,
  PRESSURE_INV_RANGE,
  pressureLut,
  pressureGradientCss,
  pressureLegendTicks,
} from './pressure-scale';
import { buildWindField, type WindField } from './wind-field';

/** Ajustes do efeito de vento — mexa aqui para calibrar o visual. */
const WIND = {
  particles: 2000,        // quantidade de partículas (mais = mais denso, mais pesado)
  textureW: 1024,         // resolução da textura onde as partículas são desenhadas
  textureH: 1024,
  gridStep: 2,            // resolução (em graus) do campo de vento interpolado
  idwNeighbors: 100,      // nº de pontos de dados vizinhos usados na interpolação
  tempSigmaLat: 9,        // suavização dos campos de cor (graus): ~0,6× o espaçamento da grade (15°) elimina as "bolhas" em volta de cada ponto
  tempSigmaLon: 11,       // idem, em longitude
  speedFactor: 0.006,     // graus percorridos por frame para cada 1 km/h de vento
  fade: 0.07,             // 0.05 = rastro longo | 0.2 = rastro curto
  lineWidth: 1.5,
  maxSpeed: 60,           // km/h que corresponde à cor "mais forte"
  minAge: 50,             // vida da partícula, em frames
  maxAge: 120,
  buckets: 24,            // faixas de cor (1 stroke por faixa)
  tempMin: TEMP_RANGE.min, // °C que corresponde à cor mais fria (ver temperature-scale.ts)
  tempMax: TEMP_RANGE.max, // °C que corresponde à cor mais quente
  maxLat: 85,
};

/** Camada de temperatura: opacidade nos oceanos e, se você fornecer países, terra cinza com fronteiras. */
const LAND = {
  textureW: 2048,                       // resolução da textura da terra (fronteiras nítidas)
  textureH: 1024,
  oceanAlpha: 0.6,                      // opacidade das cores nos oceanos (1 = sólido)
  fillColor: 'rgb(140, 144, 150)',      // cinza da terra; com rgba(..., 0.8) a temperatura aparece de leve
  borderColor: 'rgba(255, 255, 255, 0.6)',
  borderWidth: 1,
};

/** Globo base e renderização. */
const GLOBE = {
  // Textura leve (2048×1024, ~300 KB) servida pelo próprio app: o globo aparece em poucos ms.
  // Coloque earth-blue-marble-2k.jpg na pasta public/ (Angular 18+) ou em src/assets/ (e use 'assets/...').
  lowResUrl: 'earth-blue-marble-2k.jpg',
  // Textura completa (4096×2048, ~1,5 MB): baixada DEPOIS que o vento já está na tela e trocada sem piscar.
  // Use null para ficar só com a leve.
  hiResMaxWaitMs: 4000,        // se o vento demorar, baixa a textura completa mesmo assim após esse tempo
  placeholderColor: 0x0d1f3d,  // cor da esfera até a textura chegar
  dim: 0.5,                    // escurece o mapa base para o vento se destacar (estilo nullschool)
  shininess: 4,
  segments: 64,                // lados das esferas (64 é indistinguível de 96/128 nesse tamanho)
  maxPixelRatio: 2,            // limite da densidade de pixels (3× em telas retina custa 2,25× mais preenchimento)
};

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const INV_360 = 1 / 360;
const INV_180 = 1 / 180;
const GLOBE_RADIUS = 100;
const TEMP_SPHERE_RADIUS = 100.25;   // camada de temperatura, logo acima da superfície
const WIND_SPHERE_RADIUS = 100.5;    // esfera do vento, acima da camada de temperatura

// ── Constantes pré-calculadas: multiplicar por estes recíprocos substitui divisões nos laços quentes ──
const INV_GRID_STEP = 1 / WIND.gridStep;
const INV_MAX_SPEED = 1 / WIND.maxSpeed;
const MAX_SIN_LAT = Math.sin(WIND.maxLat * D2R);
const AGE_SPAN = WIND.maxAge - WIND.minAge;
const WIND_X_SCALE = WIND.textureW * INV_360;     // longitude(°) → pixel
const WIND_Y_SCALE = WIND.textureH * INV_180;     // latitude(°)  → pixel
const WIND_HALF_W = WIND.textureW * 0.5;
const FADE_STYLE = `rgba(0, 0, 0, ${WIND.fade})`;

/** 1 / max(cos(lat), 0.12), tabelado a cada 0,1°: evita Math.cos + divisão por partícula a cada frame. */
const COS_RES = 10;
const INV_COS = (() => {
  const t = new Float32Array(180 * COS_RES + 2);
  for (let i = 0; i < t.length; i++) t[i] = 1 / Math.max(Math.cos((-90 + i / COS_RES) * D2R), 0.12);
  return t;
})();

/** Rampa de cor por velocidade: azul → ciano → verde → branco. */
const SPEED_STOPS = [
  { t: 0.0, c: [90, 150, 255, 0.55] },
  { t: 0.35, c: [80, 220, 210, 0.75] },
  { t: 0.65, c: [170, 255, 120, 0.85] },
  { t: 1.0, c: [255, 255, 235, 0.95] },
];

/** Cursor do mouse sobre o globo: a bolinha azul. */
const GLOBE_CURSOR =
  `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="%2338bdf8" stroke="%230f172a" stroke-width="1.5"/></svg>') 8 8, auto`;

/** Camada de temperatura na GPU: campo (half-float) → paleta, com a terra opcional por cima. */
const TEMP_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const TEMP_FRAGMENT = /* glsl */ `
  uniform sampler2D uField;   // temperatura (°C) na grade do campo; filtro linear = interpolação bilinear
  uniform sampler2D uLut;     // paleta 1D
  uniform sampler2D uLand;    // terra + fronteiras (alfa pré-multiplicado); 1×1 transparente se não houver
  uniform float uOcean;       // opacidade nos oceanos
  uniform float uMin;
  uniform float uInvRange;
  uniform vec3 uGrid;         // x: 0.5/nx   y: (ny-1)/ny   z: 0.5/ny   (alinha os centros dos texels às células)
  uniform vec2 uLutMap;       // x: (n-1)/n  y: 0.5/n
  varying vec2 vUv;
  void main() {
    float t = texture2D(uField, vec2(vUv.x + uGrid.x, vUv.y * uGrid.y + uGrid.z)).r;
    float k = clamp((t - uMin) * uInvRange, 0.0, 1.0);
    vec3 ocean = texture2D(uLut, vec2(k * uLutMap.x + uLutMap.y, 0.5)).rgb;
    vec4 land = texture2D(uLand, vUv);
    float a = land.a + uOcean * (1.0 - land.a);
    vec3 rgb = (land.rgb + ocean * uOcean * (1.0 - land.a)) / max(a, 0.0001);
    gl_FragColor = vec4(rgb, a);
  }
`;

/**
 * Imagens de satélite da NASA (GIBS, serviço WMS gratuito e sem chave) do dia escolhido no filtro.
 * Cada satélite deixa buracos pretos entre as passadas, mas a passada de um cai nos buracos do outro: os quatro são baixados
 * ao mesmo tempo, o preto de cada um é recortado e eles são empilhados (o melhor por cima). A textura só aparece quando
 * todos responderam, já completa.
 */
const SAT = {
  layers: [
    // Ordem = prioridade (o primeiro fica por cima). `width` = largura pedida ao servidor.
    { id: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',   name: 'VIIRS SNPP',    width: 4096 },
    { id: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', name: 'VIIRS NOAA-20', width: 2048 },   // passa meia órbita depois do SNPP: cai nos buracos dele
    { id: 'MODIS_Terra_CorrectedReflectance_TrueColor',  name: 'MODIS Terra',   width: 2048 },
    { id: 'MODIS_Aqua_CorrectedReflectance_TrueColor',   name: 'MODIS Aqua',    width: 2048 },
  ],
  endpoint: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi',
  width: 4096,              // largura da textura final (limitada pelo que a GPU aceita)
  radius: 100.1,            // acima do mapa base, abaixo de temperatura/pressão e do vento
  opacity: 1,
  dark: 12,                 // pixel com R, G e B abaixo disto = "sem dado" (buraco)
  erode: 3,                 // px tirados da borda de cada faixa (a borda do JPEG fica meio escura e deixaria um fio preto)
  timeoutMs: 45000,
};

const satelliteUrl = (layer: string, date: string, w: number, h: number): string =>
  `${SAT.endpoint}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=${layer}&STYLES=&SRS=EPSG:4326` +
  `&BBOX=-180,-90,180,90&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/jpeg&TIME=${date}`;

/** Tira `r` pixels da borda das áreas válidas (1 = tem dado). Fora da imagem conta como válido. */
function erodeMask(m: Uint8Array, w: number, h: number, r: number): void {
  const t = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const a = x - r < 0 ? 0 : x - r, b = x + r >= w ? w - 1 : x + r;
      let v = 1;
      for (let k = a; k <= b; k++) if (!m[o + k]) { v = 0; break; }
      t[o + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    const a = y - r < 0 ? 0 : y - r, b = y + r >= h ? h - 1 : y + r;
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let k = a; k <= b; k++) if (!t[k * w + x]) { v = 0; break; }
      m[y * w + x] = v;
    }
  }
}

/**
 * Transforma a imagem baixada numa "peça" para empilhar: o que é preto (sem dado) e `SAT.erode` px em volta ficam transparentes.
 * Devolve null se a imagem veio toda preta (o satélite não tinha dado nesse dia).
 */
function buildSatPiece(bmp: ImageBitmap): HTMLCanvasElement | null {
  const w = bmp.width, h = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data, T = SAT.dark;
  const ok = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0, p = 0; i < ok.length; i++, p += 4) {
    if (d[p] >= T || d[p + 1] >= T || d[p + 2] >= T) { ok[i] = 1; n++; }
  }
  if (n < ok.length * 0.001) return null;

  erodeMask(ok, w, h, SAT.erode);
  for (let i = 0, p = 0; i < ok.length; i++, p += 4) d[p + 3] = ok[i] ? 255 : 0;
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** O que continuar preto depois de empilhar os satélites (ex.: noite polar) vira transparente: aparece o mapa base. */
const SAT_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(uMap, vec2(vUv.x, 1.0 - vUv.y)).rgb;   // a imagem começa no norte
    float a = smoothstep(0.02, 0.09, max(c.r, max(c.g, c.b)));
    gl_FragColor = vec4(c, a * uOpacity);
  }
`;

/** Camadas de cor que cobrem o globo (só uma por vez: as duas pintam a mesma superfície). */
type ScalarKind = 'temperature' | 'pressure';

interface ScalarLayer {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  field: THREE.DataTexture;
  lut: THREE.DataTexture;
}

const LUT_SIZE = 512;

@Component({
  selector: 'app-earth-globe',
  styleUrl: './earth-globe.scss',
  templateUrl: './earth-globe.html',
  imports: [InfoGram, TemperatureLegend]
})
export class EarthGlobe implements AfterViewInit, OnDestroy {
  @ViewChild('canvasContainer', { static: true }) containerRef!: ElementRef<HTMLDivElement>;

  private platformId = inject(PLATFORM_ID);
  private globeFacade = inject(GlobeFacade);
  private zone = inject(NgZone);

  constructor() {
    // A carga é em 2 etapas: quando a grade completa chega, o campo da tela (feito com a grade grossa) é refeito
    effect(() => {
      const v = this.globeFacade.dataVersion();
      untracked(() => {
        if (v === 0 || !this.field || this.destroyed || this.timeIdx < 0) return;
        this.selectIndex(this.timeIdx);
      });
    });
  }

  apiStatus = signal<string>('Loading wind data...');
  isLoaded = signal<boolean>(false);
  colorMode = signal<'temperature' | 'speed'>('temperature');

  /**
   * false = o globo está montado mas escondido (usuário em outra rota): continua construído e com a GPU
   * "aquecida" (texturas e shaders já enviados), porém sem animar o vento nem tratar mouse/câmera.
   */
  readonly active = input(true);

  // ── Filtro de data e hora (horas já baixadas: sem requisição; dia fora da memória: baixa na NASA POWER) ──
  readonly timeReady = signal(false);                 // true quando os dados horários chegaram
  readonly selDate = signal('');                      // 'AAAA-MM-DD' (horário local do usuário)
  readonly selHour = signal(0);                       // 0..23 (horário local)
  readonly dateNotice = signal('');                   // aviso quando a data pedida não tem dados
  readonly dateMin = signal('');
  readonly dateMax = signal('');
  readonly timeLabel = signal('');                    // ex.: "dom., 15 de nov., 14:00"
  readonly timeKind = signal<'past' | 'now' | 'forecast'>('now');
  readonly updating = signal(false);                  // true enquanto o campo da nova hora é recalculado

  /** Enquanto a grade completa ainda é baixada em segundo plano (o globo já está na tela), ex.: "refinando 150/264". */
  readonly refineText = computed(() => {
    const p = this.globeFacade.loadProgress();
    return this.isLoaded() && p.total && p.done < p.total ? `refining ${p.done}/${p.total}` : '';
  });
  private timeIdx = -1;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private buildToken = 0;                             // descarta cálculos antigos quando o usuário muda de hora de novo

  // Legenda de temperatura (gerada da mesma escala usada no globo)
  readonly tempGradient = temperatureGradientCss();
  readonly tempTicks = temperatureLegendTicks(5);
  readonly tempBands = temperatureLegendBands();

  // Three.js
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private earth = new THREE.Group();           // gira globo + camadas juntos
  private globeMat!: THREE.MeshPhongMaterial;
  private globeGeo!: THREE.SphereGeometry;
  private baseTexture: THREE.Texture | null = null;
  private weatherMesh: THREE.Mesh | null = null;
  private animationFrameId = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hiResTimer: ReturnType<typeof setTimeout> | null = null;
  private hiResStarted = false;
  private resizeObserver: ResizeObserver | null = null;
  private destroyed = false;

  // Render sob demanda: só desenha quando algo mudou (câmera, camada, textura) ou o vento está animando
  private dirty = true;
  private viewW = 1;
  private viewH = 1;
  private invViewW = 1;
  private invViewH = 1;

  // Camadas de temperatura/pressão (criadas só na primeira vez que o usuário liga cada uma)
  private scalarLayers: Partial<Record<ScalarKind, ScalarLayer>> = {};
  private emptyLand: THREE.DataTexture | null = null;
  private landTexture: THREE.CanvasTexture | null = null;
  private landFeatures: any[] | null = null;   // países (GeoJSON) — veja setLandFeatures()

  activeLayers = new Set<string>(['wind']);

  // Imagem de satélite (criada só na primeira vez que o usuário liga)
  readonly satStatus = signal('');
  private satMesh: THREE.Mesh | null = null;
  private satMat: THREE.ShaderMaterial | null = null;
  private satTexture: THREE.Texture | null = null;
  private satDate = '';          // dia (UTC) da imagem que está na tela ou sendo baixada
  private satToken = 0;          // descarta downloads antigos quando o dia muda de novo
  private satFailDate = '';       // dia que falhou por completo...
  private satRetryAt = 0;         // ...e quando vale tentar de novo (evita repetir a cada troca de hora se o servidor está fora)

  // Legenda de pressão (gerada da mesma escala usada no globo)
  readonly pressGradient = pressureGradientCss();
  readonly pressTicks = pressureLegendTicks(5);

  toggleLayer(layerType: string, event: Event) {
    const input = event.target as HTMLInputElement;

    // Atualiza o Set com base no estado real do checkbox
    if (input.checked) {
      this.activeLayers.add(layerType);

      // Temperatura e pressão pintam a mesma superfície: ligar uma desliga a outra (e o checkbox dela)
      const other = layerType === 'temperature' ? 'pressure' : layerType === 'pressure' ? 'temperature' : null;
      if (other) {
        this.activeLayers.delete(other);
        const otherInput = input.closest('.filter-group')?.querySelector<HTMLInputElement>(`input[value="${other}"]`);
        if (otherInput) otherInput.checked = false;
      }
    } else {
      this.activeLayers.delete(layerType);
    }

    this.applyLayerVisibility();
  }

  /** Liga/desliga cada camada conforme o Set. As de cor só são construídas na primeira vez que são ligadas. */
  private applyLayerVisibility(): void {
    const satOn = this.activeLayers.has('satellite');
    if (satOn) {
      this.ensureSatelliteLayer();
      void this.refreshSatellite();
    } else {
      this.satToken++;               // cancela um download em andamento
      this.satDate = '';
      this.satRetryAt = 0;
      if (this.satStatus()) this.zone.run(() => this.satStatus.set(''));
    }
    if (this.satMesh) this.satMesh.visible = satOn && !!this.satTexture;

    if (this.weatherMesh) this.weatherMesh.visible = this.activeLayers.has('wind') && !!this.field;

    for (const kind of ['temperature', 'pressure'] as const) {
      const on = this.activeLayers.has(kind) && !!this.field;
      if (on) this.ensureScalarLayer(kind);
      const layer = this.scalarLayers[kind];
      if (layer) layer.mesh.visible = on;
    }
    this.dirty = true;
  }

  // Campo de vento (grade regular lon/lat, valores em km/h): u, v, t intercalados em `uvt`
  private field: WindField | null = null;
  // Células/pesos da última amostragem bilinear (usados pelo tooltip)
  private cell = { i00: 0, i10: 0, i01: 0, i11: 0, w00: 0, w10: 0, w01: 0, w11: 0 };

  // Tooltip (hover)
  private tooltipEl: HTMLDivElement | null = null;
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hitPoint = new THREE.Vector3();
  private pickSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), WIND_SPHERE_RADIUS);
  private pointerX = 0;
  private pointerY = 0;
  private hover = false;
  private dragging = false;
  private tooltipDirty = false;
  private tipVisible = false;
  private tipW = 0;
  private tipH = 0;
  private lastHtml = '';
  private currentPos: number[] = [];

  // Partículas
  private px!: Float32Array;                   // longitude
  private py!: Float32Array;                   // latitude
  private age!: Float32Array;
  private life!: Float32Array;

  // Canvas 2D que vira textura
  private windCanvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private windTexture!: THREE.CanvasTexture;
  private bucketBuf: Float32Array[] = [];
  private bucketCnt = new Int32Array(WIND.buckets);
  private bucketColors: string[] = [];
  private lastTime = 0;

  ngAfterViewInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    // 1) Tudo síncrono e leve: o primeiro frame (esfera escura) sai no próximo rAF
    this.initScene();
    this.zone.runOutsideAngular(() => {
      this.startRenderLoop();

      // 2) A rede começa já: textura leve do globo (a textura chega e troca a esfera escura)
      void this.loadBaseTexture();

      // 3) O resto espera o 1º frame ser pintado, para não atrasá-lo
      requestAnimationFrame(() => requestAnimationFrame(() => this.afterFirstPaint()));
    });
  }

  private afterFirstPaint(): void {
    if (this.destroyed) return;
    this.initWindLayer();
    this.initTooltip();
    this.applyCursor();
    this.loadWindData();
  }

  // ───────────────────────── Cena 3D ─────────────────────────

  private initScene(): void {
    const container = this.containerRef.nativeElement;
    const width = container.clientWidth;
    const height = container.clientHeight;
    this.setViewSize(width, height);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    this.camera.position.set(0, 0, 320);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      stencil: false,                       // não usamos stencil: economiza memória de vídeo
      powerPreference: 'high-performance'   // pede a GPU dedicada em notebooks com duas GPUs
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, GLOBE.maxPixelRatio));
    this.renderer.setSize(width, height);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.04;
    this.controls.minDistance = 120;
    this.controls.maxDistance = 600;
    this.controls.addEventListener('change', this.onCameraChange);
    this.applyCursor();   // depois dos controles: versões novas do OrbitControls também escrevem em style.cursor

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.5));
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
    sunLight.position.set(300, 200, 300);
    this.scene.add(sunLight);

    // Globo base: esfera própria (antes vinha do three-globe, que arrastava d3/kapsule/tween para o bundle)
    this.globeGeo = new THREE.SphereGeometry(GLOBE_RADIUS, GLOBE.segments, GLOBE.segments);
    // A textura chega como ImageBitmap (decodificada fora da thread principal) e não pode ser invertida
    // no upload, então invertemos o V uma vez na geometria.
    const uv = this.globeGeo.attributes['uv'] as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));

    this.globeMat = new THREE.MeshPhongMaterial({ color: GLOBE.placeholderColor, shininess: GLOBE.shininess });
    const globe = new THREE.Mesh(this.globeGeo, this.globeMat);
    // Mesmo alinhamento que o three-globe usava: meridiano 0 ao longo do eixo Z
    globe.rotation.y = -Math.PI / 2;
    this.earth.add(globe);

    this.scene.add(this.earth);

    // ResizeObserver cobre tanto a janela quanto mudanças de layout do container
    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(container);
  }

  private setViewSize(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.invViewW = w ? 1 / w : 1;
    this.invViewH = h ? 1 / h : 1;
  }

  /** (Re)aplica a bolinha como cursor. Barato: só escreve uma string no style do canvas. */
  private applyCursor = (): void => {
    this.renderer.domElement.style.cursor = GLOBE_CURSOR;
  };

  private onCameraChange = (): void => {
    this.dirty = true;
    this.tooltipDirty = true;
  };

  // ───────────────────────── Textura do globo (progressiva) ─────────────────────────

  /** Baixa e decodifica a imagem fora da thread principal (createImageBitmap) e devolve a textura. */
  private async fetchTexture(url: string): Promise<THREE.Texture> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    const bitmap = await createImageBitmap(await res.blob());

    const tex = new THREE.Texture(bitmap as unknown as HTMLImageElement);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;                        // ImageBitmap ignora o flip do upload (o V foi invertido na geometria)
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    return tex;
  }

  private setBaseTexture(tex: THREE.Texture): void {
    if (this.destroyed) { tex.dispose(); return; }
    const old = this.baseTexture;
    this.baseTexture = tex;
    this.globeMat.map = tex;
    this.globeMat.color.setScalar(GLOBE.dim);   // escurece o mapa base (estilo nullschool)
    this.globeMat.needsUpdate = true;           // só na 1ª vez muda o shader; nas trocas é grátis
    old?.dispose();
    this.dirty = true;
  }

  private async loadBaseTexture(): Promise<void> {
    try {
      this.setBaseTexture(await this.fetchTexture(GLOBE.lowResUrl));
      return;
    } catch (err) {
      console.warn('Textura leve não encontrada, usando a completa:', err);
    }
  }

  /** Baixa a textura completa (uma única vez) e troca a leve por ela. */
  private async startHiRes(): Promise<void> {
    this.hiResStarted = true;
    if (this.hiResTimer) { clearTimeout(this.hiResTimer); this.hiResTimer = null; }
    if (this.renderer.capabilities.maxTextureSize < 4096) return;   // GPU pequena: a leve basta
  }

  // ───────────────────────── Países (opcional) ─────────────────────────

  /**
   * Fornece os países (GeoJSON, ex.: Natural Earth) para pintar a terra em cinza com fronteiras
   * sobre a camada de temperatura (cores só nos oceanos, opacidade em LAND.oceanAlpha).
   * Sem chamar isto, a camada de temperatura cobre o globo inteiro, como na sua versão atual.
   */
  setLandFeatures(features: any[] | null): void {
    this.landFeatures = features;
    this.landTexture?.dispose();
    this.landTexture = this.buildLandTexture();
    for (const layer of Object.values(this.scalarLayers)) {
      layer.mat.uniforms['uLand'].value = this.landTexture ?? this.emptyLand;
      this.dirty = true;
    }
  }

  private buildLandTexture(): THREE.CanvasTexture | null {
    if (!this.landFeatures?.length) return null;

    const canvas = document.createElement('canvas');
    canvas.width = LAND.textureW;
    canvas.height = LAND.textureH;
    this.drawLand(canvas.getContext('2d')!, canvas.width, canvas.height);

    const tex = new THREE.CanvasTexture(canvas);
    tex.premultiplyAlpha = true;              // o shader espera alfa pré-multiplicado (bordas corretas nos mipmaps)
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  /**
   * Desenha os países sobre a textura (projeção equiretangular, igual à da esfera):
   * preenchimento cinza + fronteiras brancas. Ignora as "costuras" em ±180° e no polo sul,
   * para não aparecer uma linha reta atravessando o mapa.
   */
  private drawLand(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    if (!this.landFeatures?.length) return;

    const xs = W * INV_360;
    const ys = H * INV_180;
    const px = (lon: number) => (lon + 180) * xs;
    const py = (lat: number) => (90 - lat) * ys;

    const borders = new Path2D();

    ctx.fillStyle = LAND.fillColor;

    for (const feature of this.landFeatures) {
      const g = feature?.geometry;
      if (!g) continue;

      const polygons: number[][][][] =
        g.type === 'Polygon' ? [g.coordinates] :
          g.type === 'MultiPolygon' ? g.coordinates : [];

      for (const polygon of polygons) {
        // Preenchimento por polígono (anéis internos viram buracos com 'evenodd')
        const shape = new Path2D();

        for (const ring of polygon) {
          for (let k = 0; k < ring.length; k++) {
            const [lon, lat] = ring[k];
            const x = px(lon), y = py(lat);

            if (k === 0) {
              shape.moveTo(x, y);
              borders.moveTo(x, y);
              continue;
            }

            shape.lineTo(x, y);

            const [plon, plat] = ring[k - 1];
            const onSeam =
              (Math.abs(plon) > 179.99 && Math.abs(lon) > 179.99) ||
              (plat < -89.99 && lat < -89.99);

            if (onSeam) borders.moveTo(x, y);
            else borders.lineTo(x, y);
          }
          shape.closePath();
        }

        ctx.fill(shape, 'evenodd');
      }
    }

    ctx.lineWidth = LAND.borderWidth;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = LAND.borderColor;
    ctx.stroke(borders);
  }

  // ───────────────────────── Camadas de cor (GPU): temperatura e pressão ─────────────────────────

  /** Escreve o campo (temperatura ou pressão) da hora atual em `half` (half-float). Devolve false se não há dado. */
  private fillScalarHalf(kind: ScalarKind, half: Uint16Array): boolean {
    const f = this.field!;
    const count = half.length;

    if (kind === 'temperature') {
      const uvt = f.uvt;
      for (let o = 0; o < count; o++) half[o] = THREE.DataUtils.toHalfFloat(uvt[o * 3 + 2]);
      return true;
    }

    // Pressão: guarda (hPa - mínimo) para o half-float ter precisão de ~0,06 hPa; NaN vira a média
    const p = f.p;
    let sum = 0, n = 0;
    for (let o = 0; o < count; o++) { const v = p[o]; if (v === v) { sum += v; n++; } }
    if (!n) {
      console.warn('Sem dados de pressão na resposta da API (pressure_msl ou surface_pressure).');
      return false;
    }
    const mean = sum / n;
    for (let o = 0; o < count; o++) {
      const v = p[o];
      half[o] = THREE.DataUtils.toHalfFloat((v === v ? v : mean) - PRESSURE_RANGE.min);
    }
    return true;
  }

  /** Troca o conteúdo das camadas já criadas pelo da hora atual (reaproveita texturas, shaders e malhas). */
  private refreshScalarLayers(): void {
    for (const kind of ['temperature', 'pressure'] as const) {
      const layer = this.scalarLayers[kind];
      if (!layer) continue;
      const data = (layer.field.image as any).data as Uint16Array;
      if (this.fillScalarHalf(kind, data)) layer.field.needsUpdate = true;
    }
    this.dirty = true;
  }

  /**
   * Cria a camada de temperatura ou de pressão. Em vez de pintar 524 mil pixels no JS e subir uma textura grande,
   * sobe só o campo (180×91 valores, ~32 KB) e uma paleta de 512 cores; o fragment shader interpola
   * (filtro linear) e pinta cada pixel na GPU. Custo no JS: praticamente zero.
   */
  private ensureScalarLayer(kind: ScalarKind): void {
    const f = this.field;
    if (this.scalarLayers[kind] || !f) return;
    const { nx, ny } = f;
    const count = nx * ny;

    // Campo → half-float (a GPU filtra half-float linearmente em qualquer WebGL2)
    const half = new Uint16Array(count);
    if (!this.fillScalarHalf(kind, half)) return;
    const isTemp = kind === 'temperature';
    const min = isTemp ? TEMP_RANGE.min : 0;
    const invRange = isTemp ? TEMP_INV_RANGE : PRESSURE_INV_RANGE;
    const lutData = isTemp ? temperatureLut(LUT_SIZE) : pressureLut(LUT_SIZE);

    const fieldTex = new THREE.DataTexture(half, nx, ny, THREE.RedFormat, THREE.HalfFloatType);
    fieldTex.minFilter = THREE.LinearFilter;
    fieldTex.magFilter = THREE.LinearFilter;
    fieldTex.wrapS = THREE.RepeatWrapping;          // dá a volta na longitude (±180°)
    fieldTex.wrapT = THREE.ClampToEdgeWrapping;
    fieldTex.generateMipmaps = false;
    fieldTex.unpackAlignment = 1;
    fieldTex.needsUpdate = true;

    const lutTex = new THREE.DataTexture(lutData, LUT_SIZE, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    lutTex.minFilter = THREE.LinearFilter;
    lutTex.magFilter = THREE.LinearFilter;
    lutTex.wrapS = lutTex.wrapT = THREE.ClampToEdgeWrapping;
    lutTex.generateMipmaps = false;
    lutTex.needsUpdate = true;

    // Textura 1×1 transparente: usada quando não há terra (evita um branch no shader)
    if (!this.emptyLand) {
      this.emptyLand = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      this.emptyLand.needsUpdate = true;
    }
    this.landTexture ??= this.buildLandTexture();

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uField: { value: fieldTex },
        uLut: { value: lutTex },
        uLand: { value: this.landTexture ?? this.emptyLand },
        uOcean: { value: LAND.oceanAlpha },
        uMin: { value: min },
        uInvRange: { value: invRange },
        uGrid: { value: new THREE.Vector3(0.5 / nx, (ny - 1) / ny, 0.5 / ny) },
        uLutMap: { value: new THREE.Vector2((LUT_SIZE - 1) / LUT_SIZE, 0.5 / LUT_SIZE) },
      },
      vertexShader: TEMP_VERTEX,
      fragmentShader: TEMP_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(new THREE.SphereGeometry(TEMP_SPHERE_RADIUS, GLOBE.segments, GLOBE.segments), mat);
    // Mesmo alinhamento geográfico da esfera de vento
    mesh.rotation.y = -Math.PI / 2;
    // A camada fica abaixo das partículas de vento
    mesh.renderOrder = 1;
    mesh.visible = false;
    this.earth.add(mesh);

    this.scalarLayers[kind] = { mesh, mat, field: fieldTex, lut: lutTex };
  }

  // ───────────────────────── Imagem de satélite (NASA GIBS) ─────────────────────────

  private ensureSatelliteLayer(): void {
    if (this.satMesh || !this.scene) return;

    this.satMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uOpacity: { value: SAT.opacity } },
      vertexShader: TEMP_VERTEX,
      fragmentShader: SAT_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    this.satMesh = new THREE.Mesh(new THREE.SphereGeometry(SAT.radius, GLOBE.segments, GLOBE.segments), this.satMat);
    this.satMesh.rotation.y = -Math.PI / 2;     // mesmo alinhamento das outras camadas
    this.satMesh.renderOrder = 0;
    this.satMesh.visible = false;
    this.earth.add(this.satMesh);
  }

  /**
   * Dia (UTC, 'AAAA-MM-DD') da hora escolhida no filtro, mas nunca o dia de hoje: a NASA ainda está montando a imagem do dia
   * corrente (faltam passadas, daí os buracos), então usa-se o último dia completo, ontem.
   */
  private satelliteDate(): string {
    const tl = this.timeline;
    const ts = tl.length && this.timeIdx >= 0 ? tl[Math.min(this.timeIdx, tl.length - 1)] : Date.now();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return new Date(Math.min(ts, today.getTime() - 1)).toISOString().slice(0, 10);
  }

  private async fetchBitmap(url: string): Promise<ImageBitmap> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SAT.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await createImageBitmap(await res.blob());     // se o GIBS responder um erro em XML, falha aqui e a camada é ignorada
    } finally {
      clearTimeout(timer);
    }
  }

  /** Baixa os satélites do dia do filtro (se ainda não são os da tela), empilha numa só imagem e troca a textura. */
  private async refreshSatellite(): Promise<void> {
    if (this.destroyed || !this.activeLayers.has('satellite') || !this.satMat) return;

    const date = this.satelliteDate();
    if (date === this.satDate) return;
    if (date === this.satFailDate && Date.now() < this.satRetryAt) return;
    this.satDate = date;
    const token = ++this.satToken;
    const alive = () => !this.destroyed && token === this.satToken;
    const label = this.usDate(date);
    this.zone.run(() => this.satStatus.set(`Loading satellite images for ${label}…`));

    const maxTex = this.renderer.capabilities.maxTextureSize;
    const layers = SAT.layers;

    // Os satélites são baixados ao mesmo tempo. Se nenhum vier por falha de rede/servidor, repete com imagens menores
    let pieces: (HTMLCanvasElement | null)[] = [];
    for (const scale of [1, 0.5, 0.25]) {
      let transient = false;
      pieces = await Promise.all(layers.map(async l => {
        const w = Math.max(512, Math.round(Math.min(l.width, maxTex) * scale / 2) * 2);
        try {
          const bmp = await this.fetchBitmap(satelliteUrl(l.id, date, w, w / 2));
          if (!alive()) { bmp.close(); return null; }
          const piece = buildSatPiece(bmp);
          bmp.close();
          return piece;                           // null = veio toda preta: esse satélite não tem dado nesse dia
        } catch (err) {
          if (alive()) console.warn(`[Satélite] ${l.name} ${date} ${w}×${w / 2}:`, err);
          const e = err as Error;
          if (!(e?.name === 'InvalidStateError' || /^HTTP 4\d\d/.test(e?.message ?? ''))) transient = true;
          return null;
        }
      }));
      if (!alive()) return;
      if (pieces.some(Boolean) || !transient) break;
    }

    const used = layers.filter((_, i) => pieces[i]);
    if (!used.length) {
      this.satDate = '';                          // deixa tentar de novo...
      this.satFailDate = date;                    // ...mas só daqui a pouco, para não martelar o servidor a cada troca de hora
      this.satRetryAt = Date.now() + 60000;
      this.zone.run(() => this.satStatus.set('Satellite imagery unavailable right now.'));
      return;
    }
    this.satRetryAt = 0;

    // Empilha da pior para a melhor prioridade: onde a melhor não tem dado, aparece a seguinte
    const W = Math.min(SAT.width, maxTex), H = W / 2;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let i = layers.length - 1; i >= 0; i--) {
      const p = pieces[i];
      if (p) ctx.drawImage(p, 0, 0, W, H);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false;                            // o shader já considera que a imagem começa no norte
    tex.colorSpace = THREE.NoColorSpace;          // o shader entrega as cores sem conversão
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const old = this.satTexture;
    this.satTexture = tex;
    this.satMat!.uniforms['uMap'].value = tex;
    old?.dispose();
    if (this.satMesh) this.satMesh.visible = this.activeLayers.has('satellite');
    this.dirty = true;

    this.zone.run(() => this.satStatus.set(`NASA GIBS satellites (${used.map(l => l.name).join(' + ')}) · ${label}`));
  }

  // ───────────────────────── Canvas das partículas ─────────────────────────

  private initWindLayer(): void {
    this.windCanvas = document.createElement('canvas');
    this.windCanvas.width = WIND.textureW;
    this.windCanvas.height = WIND.textureH;
    this.ctx = this.windCanvas.getContext('2d')!;
    this.ctx.lineCap = 'butt';   // 'round' sobrepõe as pontas a cada frame e vira pontilhado
    this.ctx.lineWidth = WIND.lineWidth;

    this.windTexture = new THREE.CanvasTexture(this.windCanvas);
    this.windTexture.colorSpace = THREE.SRGBColorSpace;
    this.windTexture.wrapS = THREE.RepeatWrapping;
    this.windTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.windTexture.generateMipmaps = false;      // a textura muda todo frame
    this.windTexture.minFilter = THREE.LinearFilter;
    this.windTexture.magFilter = THREE.LinearFilter;

    // Esfera do vento, logo acima da superfície (o globo tem raio 100)
    this.weatherMesh = new THREE.Mesh(
      new THREE.SphereGeometry(WIND_SPHERE_RADIUS, GLOBE.segments, GLOBE.segments),
      new THREE.MeshBasicMaterial({ map: this.windTexture, transparent: true, depthWrite: false })
    );
    // O three-globe gira a esfera dele em -90° em Y para alinhar o meridiano 0 ao eixo Z.
    // Sem o mesmo ajuste aqui, a textura do vento fica deslocada em longitude.
    this.weatherMesh.rotation.y = -Math.PI / 2;
    this.weatherMesh.renderOrder = 2;
    this.weatherMesh.visible = false;
    this.earth.add(this.weatherMesh);

    // Buffers por faixa de velocidade (evita alocação a cada frame)
    for (let b = 0; b < WIND.buckets; b++) {
      this.bucketBuf.push(new Float32Array(WIND.particles * 4));
    }
    this.applyColorMode();

    // Partículas
    const n = WIND.particles;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.respawn(i);
      this.age[i] = Math.random() * this.life[i]; // dessincroniza as vidas
    }
  }

  /** Cor de uma faixa de velocidade (t em 0..1). Só roda ao trocar de modo, então pode alocar. */
  private speedColor(t: number): string {
    for (let i = 1; i < SPEED_STOPS.length; i++) {
      if (t <= SPEED_STOPS[i].t) {
        const a = SPEED_STOPS[i - 1], b = SPEED_STOPS[i];
        const k = (t - a.t) / (b.t - a.t);
        const m = a.c.map((v, j) => v + (b.c[j] - v) * k);
        return `rgba(${m[0] | 0}, ${m[1] | 0}, ${m[2] | 0}, ${m[3].toFixed(2)})`;
      }
    }
    return 'rgba(255,255,235,0.95)';
  }

  /** Reconstrói as cores das faixas conforme o modo atual (temperatura ou velocidade). */
  private applyColorMode(): void {
    const useTemp = this.colorMode() === 'temperature';
    const inv = 1 / WIND.buckets;
    this.bucketColors = [];
    for (let b = 0; b < WIND.buckets; b++) {
      const t = (b + 0.5) * inv;
      this.bucketColors.push(useTemp ? particleTempColor(t) : this.speedColor(t));
    }
  }

  /** Chame isto (ex.: no clique de um botão) para trocar o que as cores representam. */
  setColorMode(mode: 'temperature' | 'speed'): void {
    this.colorMode.set(mode);
    this.applyColorMode();
  }

  // ───────────────────────── Dados → campo de vento ─────────────────────────

  /** O dado chega por fora (facade): consulta com polling leve, fora do Angular (sem change detection). */
  private loadWindData(attempt = 0): void {
    if (this.destroyed) return;

    let res: any = this.globeFacade.getData();
    if (typeof res === 'function') res = res(); // caso seja um signal
    const list = Array.isArray(res) ? res : res ? [res] : [];

    if (list.length) {
      void this.buildField(list, attempt);
      return;
    }
    this.retryOrGiveUp(attempt);
  }

  private retryOrGiveUp(attempt: number): void {
    // A carga falhou e não há dados (nem cache): para de esperar e avisa
    if (this.globeFacade.loadFailed()) {
      this.zone.run(() => {
        this.apiStatus.set('Could not get the globe data. Trying again…');
        this.updating.set(false);
      });
      // Não desiste: tenta de novo a cada 15 s (o GlobeData respeita o intervalo mínimo e o limite da API)
      this.retryTimer = setTimeout(() => this.loadWindData(0), 15000);
      return;
    }

    // Dados ainda não chegaram. A NASA POWER entrega um ponto por requisição, então a primeira carga
    // pode levar dezenas de segundos: espera até ~3 min e mostra o progresso.
    if (attempt < 900) {
      const { done, total } = this.globeFacade.loadProgress();
      if (total) {
        const txt = total > 1 ? `Loading globe data (${done}/${total})…` : 'Loading globe data…';
        if (txt !== this.apiStatus()) this.zone.run(() => this.apiStatus.set(txt));
      }
      this.retryTimer = setTimeout(() => this.loadWindData(attempt + 1), 200);
    } else {
      this.zone.run(() => {
        this.apiStatus.set('No wind data available');
        this.updating.set(false);
      });
    }
  }

  /**
   * Converte os pontos (lat, lon, direção, velocidade) numa grade regular (IDW + gaussiana).
   * Roda em fatias de ~8 ms (wind-field.ts), então o globo continua girando durante o cálculo.
   */
  private async buildField(list: any[], attempt: number): Promise<void> {
    const token = ++this.buildToken;
    const field = await buildWindField(list, {
      step: WIND.gridStep,
      idwNeighbors: WIND.idwNeighbors,
      tempSigmaLat: WIND.tempSigmaLat,
      tempSigmaLon: WIND.tempSigmaLon,
      isCancelled: () => this.destroyed || token !== this.buildToken,
    });
    if (this.destroyed || token !== this.buildToken) return;   // o usuário já escolheu outra hora
    if (!field) { this.retryOrGiveUp(attempt); return; }

    const first = !this.field;
    this.field = field;
    this.zone.run(() => {
      this.apiStatus.set('Continuous wind flow');
      this.isLoaded.set(true);
      this.updating.set(false);
      if (first) this.initTimeFilter();
    });
    this.refreshScalarLayers();      // camadas de cor já criadas passam a mostrar a nova hora
    this.applyLayerVisibility();     // cria as que o usuário ligou antes do campo existir
    this.tooltipDirty = true;
    if (first) void this.startHiRes();     // o vento já está na tela: agora vale baixar a textura completa
  }

  // ───────────────────────── Filtro de data e hora ─────────────────────────

  private get timeline(): number[] {
    return this.globeFacade.timeline();    // epoch ms (UTC) de cada hora baixada
  }

  private pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }

  private ymd(ms: number): string {
    const d = new Date(ms);
    return `${d.getFullYear()}-${this.pad2(d.getMonth() + 1)}-${this.pad2(d.getDate())}`;
  }

  /** Chamado uma vez, quando o primeiro campo fica pronto: define o intervalo permitido e seleciona "agora". */
  private initTimeFilter(): void {
    const tl = this.timeline;
    if (!tl.length) return;
    this.dateMin.set('2001-01-01');          // a NASA POWER tem dados horários desde 2001
    this.dateMax.set(this.ymd(Date.now()));
    this.timeReady.set(true);
    this.showTimeIndex(this.globeFacade.nowIndex());
  }

  /** Atualiza só a interface (data, hora, rótulo) para a hora `i`. */
  private showTimeIndex(i: number): void {
    const tl = this.timeline;
    i = Math.min(Math.max(i, 0), tl.length - 1);
    this.timeIdx = i;

    const d = new Date(tl[i]);
    this.selDate.set(this.ymd(tl[i]));
    this.selHour.set(d.getHours());
    this.timeLabel.set(d.toLocaleString('en-US', {
      weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }));

    const now = this.globeFacade.nowIndex();
    this.timeKind.set(!this.globeFacade.isLatest() || i < now ? 'past' : i > now ? 'forecast' : 'now');
  }

  /** (data, hora locais) → índice na linha do tempo, limitado ao intervalo baixado. */
  private indexFor(dateStr: string, hour: number): number {
    const tl = this.timeline;
    const [y, m, d] = dateStr.split('-').map(Number);
    const ts = new Date(y, m - 1, d, hour).getTime();
    const i = Math.round((ts - tl[0]) * (1 / 3600000));
    return Math.min(Math.max(i, 0), tl.length - 1);
  }

  private dateInputEl: HTMLInputElement | null = null;
  private loadToken = 0;                              // descarta downloads antigos quando o usuário escolhe outro dia

  /** Progresso do download de um dia, ex.: "(120/264)". */
  readonly loadText = computed(() => {
    const p = this.globeFacade.loadProgress();
    return p.total && p.done < p.total ? `(${p.done}/${p.total})` : '';
  });

  private usDate(ymd: string): string {
    const [y, m, d] = ymd.split('-');
    return `${m}/${d}/${y}`;
  }

  onDateChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.dateInputEl = input;
    if (!input.value) { input.value = this.selDate(); return; }
    void this.goTo(input.value, this.selHour());
  }

  onHourChange(e: Event): void {
    void this.goTo(this.selDate(), Number((e.target as HTMLInputElement).value));
  }

  stepHour(delta: number): void {
    const tl = this.timeline;
    if (!tl.length) return;
    const ts = tl[this.timeIdx] + delta * 3600000;
    void this.goTo(this.ymd(ts), new Date(ts).getHours());
  }

  goNow(): void {
    void this.goLatest();
  }

  /** Mantém o <input type="date"> igual à data realmente mostrada (o signal pode não mudar e o DOM ficar com o valor digitado). */
  private syncDateInput(): void {
    if (this.dateInputEl) this.dateInputEl.value = this.selDate();
  }

  /**
   * Vai para (data, hora locais). Se a hora já foi baixada, só recalcula o campo; se não, baixa o dia
   * escolhido na NASA POWER (sem limite para trás).
   */
  private async goTo(dateStr: string, hour: number): Promise<void> {
    this.dateNotice.set('');
    const tl = this.timeline;
    if (!tl.length) return;

    const [y, m, d] = dateStr.split('-').map(Number);
    const ts = new Date(y, m - 1, d, hour).getTime();
    const inside = ts >= tl[0] && ts <= tl[tl.length - 1];
    const afterLatest = ts > tl[tl.length - 1] && this.globeFacade.isLatest();   // a POWER ainda não publicou

    if (inside || afterLatest) {
      this.selectIndex(this.indexFor(dateStr, hour));
      this.finishGoTo(dateStr, afterLatest);
      return;
    }

    // Fora do que está na memória: baixa o dia escolhido
    const token = ++this.loadToken;
    this.selDate.set(dateStr);
    this.selHour.set(hour);
    this.zone.run(() => this.updating.set(true));

    const ok = await this.globeFacade.loadAround(dateStr);
    if (this.destroyed || token !== this.loadToken) return;

    if (!ok) {
      this.zone.run(() => {
        this.updating.set(false);
        this.dateNotice.set('Could not download that day (network failure or API limit). Please try again in a moment.');
      });
      this.showTimeIndex(this.timeIdx);      // volta a interface para o que está no globo
      this.syncDateInput();
      return;
    }

    this.selectIndex(this.indexFor(dateStr, hour));
    this.finishGoTo(dateStr, false);
  }

  private finishGoTo(requested: string, lag: boolean): void {
    if (requested !== this.selDate()) {
      this.dateNotice.set(`No data for ${this.usDate(requested)}.` +
        (lag ? ' NASA POWER publishes with a delay of a few days.' : '') +
        ` Showing ${this.usDate(this.selDate())}.`);
    }
    this.syncDateInput();
  }

  /** Volta para os dados mais recentes (baixa de novo se estava num dia antigo). */
  private async goLatest(): Promise<void> {
    this.dateNotice.set('');
    const token = ++this.loadToken;
    this.zone.run(() => this.updating.set(true));

    const ok = await this.globeFacade.loadLatest();
    if (this.destroyed || token !== this.loadToken) return;

    if (!ok) {
      this.zone.run(() => {
        this.updating.set(false);
        this.dateNotice.set('Could not load the latest data. Please try again in a moment.');
      });
      return;
    }
    this.selectIndex(this.globeFacade.nowIndex());
    this.syncDateInput();
  }

  /** A interface muda na hora; o recálculo do campo espera o usuário parar de arrastar (150 ms). */
  private selectIndex(i: number): void {
    if (!this.timeline.length) return;
    this.showTimeIndex(i);

    if (this.applyTimer) clearTimeout(this.applyTimer);
    const idx = this.timeIdx;
    this.zone.runOutsideAngular(() => {
      this.applyTimer = setTimeout(() => this.applyTimeIndex(idx), 150);
    });
  }

  private applyTimeIndex(i: number): void {
    if (this.destroyed) return;
    const list = this.globeFacade.getDataAt(i);   // sem requisição: as horas já estão na memória
    if (!list.length) return;
    this.zone.run(() => this.updating.set(true));
    void this.buildField(list, 999);              // 999: sem novas tentativas em loop, é só um recálculo
  }

  /** Localiza a célula da grade e os pesos bilineares para (lon, lat), com wrap em longitude. */
  private locate(lon: number, lat: number): void {
    const { nx, ny } = this.field!;

    const gx = (lon + 180) * INV_GRID_STEP;
    const gy = (lat + 90) * INV_GRID_STEP;

    const xf = Math.floor(gx);
    const fx = gx - xf;
    const x0 = ((xf % nx) + nx) % nx;
    const x1 = x0 + 1 === nx ? 0 : x0 + 1;

    const y0 = Math.min(Math.max(Math.floor(gy), 0), ny - 2);
    const fy = Math.min(Math.max(gy - y0, 0), 1);
    const y1 = y0 + 1;

    const c = this.cell;
    c.i00 = y0 * nx + x0; c.i10 = y0 * nx + x1;
    c.i01 = y1 * nx + x0; c.i11 = y1 * nx + x1;
    c.w00 = (1 - fx) * (1 - fy); c.w10 = fx * (1 - fy);
    c.w01 = (1 - fx) * fy; c.w11 = fx * fy;
  }

  /** Interpola um campo (stride = nº de valores por célula, off = qual deles) na última célula localizada. */
  private lerp(a: Float32Array, stride: number, off: number): number {
    const c = this.cell;
    return a[c.i00 * stride + off] * c.w00 + a[c.i10 * stride + off] * c.w10 +
           a[c.i01 * stride + off] * c.w01 + a[c.i11 * stride + off] * c.w11;
  }

  // ───────────────────────── Partículas ─────────────────────────

  private respawn(i: number): void {
    this.px[i] = Math.random() * 360 - 180;
    // asin(uniforme) → distribuição uniforme por área na esfera (sem aglomerar nos polos)
    this.py[i] = Math.asin((Math.random() * 2 - 1) * MAX_SIN_LAT) * R2D;
    this.age[i] = 0;
    this.life[i] = WIND.minAge + Math.random() * AGE_SPAN;
  }

  private updateWind(dt: number): void {
    const field = this.field!;
    const uvt = field.uvt;
    const nx = field.nx;
    const ny = field.ny;
    const maxY0 = ny - 2;

    const ctx = this.ctx;
    const NB = WIND.buckets;
    const NB1 = NB - 1;
    const px = this.px, py = this.py, age = this.age, life = this.life;
    const bucketBuf = this.bucketBuf;
    const bucketCnt = this.bucketCnt;
    const n = WIND.particles;
    const sfDt = WIND.speedFactor * dt;
    const maxLat = WIND.maxLat;

    // Faz os rastros antigos sumirem, mantendo o fundo transparente
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = FADE_STYLE;
    ctx.fillRect(0, 0, WIND.textureW, WIND.textureH);
    ctx.globalCompositeOperation = 'source-over';

    bucketCnt.fill(0);

    // Faixa de cor = (valor - bias) * scale; os fatores já vêm multiplicados por NB (sem divisão por partícula)
    const useTemp = this.colorMode() === 'temperature';
    const scale = useTemp ? NB * TEMP_INV_RANGE : NB * INV_MAX_SPEED;
    const bias = useTemp ? WIND.tempMin * scale : 0;

    for (let i = 0; i < n; i++) {
      const a = age[i] + dt;
      if (a > life[i]) {
        this.respawn(i);
        continue;
      }
      age[i] = a;

      const lon = px[i];
      const lat = py[i];

      // Amostragem bilinear inline (mesma conta de locate()/lerp, sem objetos nem chamadas)
      const gx = (lon + 180) * INV_GRID_STEP;
      const gy = (lat + 90) * INV_GRID_STEP;
      let xi = gx | 0;                         // lon ∈ [-180, 180] → gx ≥ 0, então |0 equivale a floor
      const fx = gx - xi;
      if (xi >= nx) xi -= nx;                  // lon === 180 → volta para a coluna 0
      const xj = xi + 1 === nx ? 0 : xi + 1;
      let yi = gy | 0;
      if (yi > maxY0) yi = maxY0;
      const fy = gy - yi;

      const r0 = yi * nx;
      const i00 = (r0 + xi) * 3, i10 = (r0 + xj) * 3;
      const i01 = (r0 + nx + xi) * 3, i11 = (r0 + nx + xj) * 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy, w11 = fx * fy;

      const u = uvt[i00] * w00 + uvt[i10] * w10 + uvt[i01] * w01 + uvt[i11] * w11;
      const v = uvt[i00 + 1] * w00 + uvt[i10 + 1] * w10 + uvt[i01 + 1] * w01 + uvt[i11 + 1] * w11;

      // Em graus de longitude, 1° encolhe com cos(lat): compensa para o vento andar "reto" na esfera
      let nLon = lon + u * sfDt * INV_COS[((lat + 90) * COS_RES + 0.5) | 0];
      const nLat = lat + v * sfDt;

      if (nLat > maxLat || nLat < -maxLat) {
        this.respawn(i);
        continue;
      }
      if (nLon > 180) nLon -= 360;
      else if (nLon < -180) nLon += 360;

      const x0 = (lon + 180) * WIND_X_SCALE;
      const y0 = (90 - lat) * WIND_Y_SCALE;
      const x1 = (nLon + 180) * WIND_X_SCALE;
      const y1 = (90 - nLat) * WIND_Y_SCALE;

      // Não desenha o segmento que cruza a "costura" da textura (±180°)
      const dx = x1 - x0;
      if (dx < WIND_HALF_W && dx > -WIND_HALF_W) {
        let value: number;
        if (useTemp) {
          value = uvt[i00 + 2] * w00 + uvt[i10 + 2] * w10 + uvt[i01 + 2] * w01 + uvt[i11 + 2] * w11;
        } else {
          value = Math.sqrt(u * u + v * v);
        }
        let b = ((value * scale) - bias) | 0;
        if (b < 0) b = 0; else if (b > NB1) b = NB1;

        const buf = bucketBuf[b];
        const c = bucketCnt[b];
        buf[c] = x0;
        buf[c + 1] = y0;
        buf[c + 2] = x1;
        buf[c + 3] = y1;
        bucketCnt[b] = c + 4;
      }

      px[i] = nLon;
      py[i] = nLat;
    }

    // Um único stroke por faixa de cor
    for (let b = 0; b < NB; b++) {
      const cnt = bucketCnt[b];
      if (!cnt) continue;
      const buf = bucketBuf[b];
      ctx.strokeStyle = this.bucketColors[b];
      ctx.beginPath();
      for (let k = 0; k < cnt; k += 4) {
        ctx.moveTo(buf[k], buf[k + 1]);
        ctx.lineTo(buf[k + 2], buf[k + 3]);
      }
      ctx.stroke();
    }

    this.windTexture.needsUpdate = true;
  }

  // ───────────────────────── Tooltip (hover) ─────────────────────────

  private initTooltip(): void {
    const container = this.containerRef.nativeElement;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';   // para posicionar o tooltip dentro do container
    }

    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      display: 'none',
      pointerEvents: 'none',     // não "rouba" o mouse do globo
      zIndex: '10',
      minWidth: '170px',
      padding: '10px 12px',
      borderRadius: '10px',
      background: 'rgba(8, 16, 36, 0.88)',
      color: '#e8f1ff',
      border: '1px solid rgba(120, 180, 255, 0.35)',
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
      font: '12px/1.5 system-ui, sans-serif',
      whiteSpace: 'nowrap',
    });
    container.appendChild(el);
    this.tooltipEl = el;

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerenter', this.applyCursor);
    dom.addEventListener('pointermove', this.onPointerMove, { passive: true });
    dom.addEventListener('pointerleave', this.onPointerLeave);
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
  }

  private onPointerMove = (e: PointerEvent): void => {
    // offsetX/Y já vêm relativos ao canvas (que ocupa o container inteiro): sem getBoundingClientRect
    this.pointerX = e.offsetX;
    this.pointerY = e.offsetY;
    this.hover = true;
    this.dragging = e.buttons !== 0;   // arrastando = girando o globo: esconde o tooltip
    this.tooltipDirty = true;
  };
  private onPointerLeave = (): void => { this.hover = false; this.hideTooltip(); };
  private onPointerDown = (): void => { this.dragging = true; this.hideTooltip(); };
  private onPointerUp = (): void => { this.dragging = false; this.applyCursor(); };

  private hideTooltip(): void {
    if (this.tooltipEl && this.tipVisible) {
      this.tooltipEl.style.display = 'none';
      this.tipVisible = false;
    }
    this.lastHtml = '';
  }

  /**
   * Converte a posição do mouse (NDC) em lon/lat no globo.
   * Interseção raio × esfera, depois passagem para o espaço local da malha do vento —
   * assim a rotação do globo e o -90° do mesh já ficam embutidos.
   * (mesma parametrização de UV da SphereGeometry: lon = u*360-180)
   */
  private pickLonLat(ndcX: number, ndcY: number): { lon: number; lat: number } | null {
    const mesh = this.weatherMesh;
    if (!mesh) return null;

    this.earth.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, this.camera);

    if (!this.raycaster.ray.intersectSphere(this.pickSphere, this.hitPoint)) return null;
    mesh.worldToLocal(this.hitPoint);

    const p = this.hitPoint;
    const lat = Math.asin(p.y / p.length()) * R2D;
    let phi = Math.atan2(p.z, -p.x);
    if (phi < 0) phi += Math.PI * 2;
    const lon = phi * (360 / (Math.PI * 2)) - 180;
    return { lon, lat };
  }

  private cardinal(deg: number): string {
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round(deg / 22.5) % 16];
  }

  private fmt(v: number, digits: number, unit: string): string {
    if (!Number.isFinite(v)) return '—';
    return `${v.toFixed(digits)}${unit === '%' ? '' : ' '}${unit}`;
  }

  /** Monta o conteúdo do tooltip para um ponto (valores interpolados da grade). */
  private tooltipHtml(lon: number, lat: number): string {
    const f = this.field!;

    this.currentPos = [lat, lon];
    this.locate(lon, lat);
    const u = this.lerp(f.uvt, 3, 0);
    const v = this.lerp(f.uvt, 3, 1);
    const temp = this.lerp(f.uvt, 3, 2);
    const press = this.lerp(f.p, 1, 0);
    const hum = this.lerp(f.h, 1, 0);

    const speed = Math.hypot(u, v);
    // Direção meteorológica: DE ONDE o vento vem (mesma convenção do wind_direction_10m)
    const dir = speed > 0.1 ? (Math.atan2(-u, -v) * R2D + 360) % 360 : NaN;

    const place = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
    const dirTxt = Number.isFinite(dir) ? `${Math.round(dir)}° ${this.cardinal(dir)}` : '—';

    const row = (label: string, value: string) =>
      `<span style="opacity:.65">${label}</span><b style="text-align:right">${value}</b>`;

    return (
      `<div style="font-weight:600;margin-bottom:6px;opacity:.9">${place}</div>` +
      `<div style="display:grid;grid-template-columns:auto auto;gap:2px 16px">` +
      row('Temperature', this.fmt(temp, 1, '°C')) +
      row('Wind', this.fmt(speed, 1, 'km/h')) +
      row('Direction (where the wind comes from)', dirTxt) +
      row('Pressure', this.fmt(press, 1, 'hPa')) +
      row('Humidity', this.fmt(hum, 0, '%')) +
      `</div>`
    );
  }

  /** Só roda quando o mouse ou a câmera se moveram (o campo é estático), não a cada frame. */
  private updateTooltip(): void {
    const el = this.tooltipEl;
    if (!el || !this.hover || this.dragging || !this.field) {
      this.hideTooltip();
      return;
    }

    const pos = this.pickLonLat(this.pointerX * this.invViewW * 2 - 1, -(this.pointerY * this.invViewH) * 2 + 1);
    if (!pos) {            // mouse fora do globo (no espaço)
      this.hideTooltip();
      return;
    }

    if (!this.tipVisible || pos.lat !== this.currentPos[0] || pos.lon !== this.currentPos[1]) {
      const html = this.tooltipHtml(pos.lon, pos.lat);
      if (html !== this.lastHtml) {
        el.innerHTML = html;
        this.lastHtml = html;
      }
      if (!this.tipVisible) { el.style.display = 'block'; this.tipVisible = true; }
      this.tipW = el.offsetWidth;     // só mede quando o conteúdo mudou (medir força layout)
      this.tipH = el.offsetHeight;
    }

    // Posiciona acima do cursor; se não couber, abre embaixo. Mantém dentro do container.
    const gap = 14;
    let x = this.pointerX - this.tipW * 0.5;
    let y = this.pointerY - this.tipH - gap;
    if (y < 4) y = this.pointerY + gap + 6;
    x = Math.min(Math.max(x, 4), Math.max(this.viewW - this.tipW - 4, 4));
    el.style.transform = `translate(${x}px, ${y}px)`;
  }

  protected async getWeatherDataOfLocation() {
    const [lat, lon] = [...this.currentPos];
    this.globeFacade.getWeatherDataOfCoord(lat, lon);
  }

  selectedWeather = signal<any | null>(null);
  selectedAstronomy = signal<any | null>(null);

  // ───────────────────────── Loop de render ─────────────────────────

  private startRenderLoop(): void {
    const animate = (now: number) => {
      this.animationFrameId = requestAnimationFrame(animate);

      // dt normalizado para 60fps (limitado para não "pular" ao voltar de outra aba)
      const dt = this.lastTime ? Math.min((now - this.lastTime) * (1 / 16.667), 3) : 1;
      this.lastTime = now;

      // Escondido (outra rota): não anima nem lê mouse. Ainda desenha UMA vez quando algo muda (textura chegou,
      // camada criada), assim a GPU já compilou os shaders e subiu as texturas quando o usuário abrir a rota.
      const active = this.active();

      // Vento só anima (e o canvas só sobe para a GPU) enquanto a camada está visível
      const windOn = active && !!this.field && !!this.weatherMesh && this.weatherMesh.visible;
      if (windOn) this.updateWind(dt);

      if (active) {
        this.controls.update();                // dispara onCameraChange quando a câmera se mexe

        if (this.tooltipDirty) {
          this.tooltipDirty = false;
          this.updateTooltip();
        }
      } else if (this.tipVisible) {
        this.hideTooltip();
      }

      // Sem vento animando e nada mudado: não redesenha (GPU e bateria em repouso)
      if (windOn || this.dirty) {
        this.dirty = false;
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.animationFrameId = requestAnimationFrame(animate);
  }

  private onResize = (): void => {
    const container = this.containerRef?.nativeElement;
    if (!container || !this.renderer) return;

    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height || (width === this.viewW && height === this.viewH)) return;

    this.setViewSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.dirty = true;
    this.tooltipDirty = true;
  };

  ngOnDestroy(): void {
    this.destroyed = true;
    if (typeof window === 'undefined') return;

    cancelAnimationFrame(this.animationFrameId);
    this.resizeObserver?.disconnect();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.hiResTimer) clearTimeout(this.hiResTimer);
    if (this.applyTimer) clearTimeout(this.applyTimer);

    if (this.renderer) {
      const dom = this.renderer.domElement;
      dom.removeEventListener('pointerenter', this.applyCursor);
      dom.removeEventListener('pointermove', this.onPointerMove);
      dom.removeEventListener('pointerleave', this.onPointerLeave);
      dom.removeEventListener('pointerdown', this.onPointerDown);
      dom.removeEventListener('pointerup', this.onPointerUp);
      dom.removeEventListener('pointercancel', this.onPointerUp);
    }
    this.tooltipEl?.remove();
    this.controls?.removeEventListener('change', this.onCameraChange);
    this.controls?.dispose();

    this.globeGeo?.dispose();
    this.globeMat?.dispose();
    this.baseTexture?.dispose();

    this.windTexture?.dispose();
    if (this.weatherMesh) {
      this.weatherMesh.geometry.dispose();
      (this.weatherMesh.material as THREE.Material).dispose();
    }

    for (const layer of Object.values(this.scalarLayers)) {
      layer.field.dispose();
      layer.lut.dispose();
      layer.mat.dispose();
      layer.mesh.geometry.dispose();
    }
    this.emptyLand?.dispose();
    this.landTexture?.dispose();

    this.satTexture?.dispose();
    this.satMat?.dispose();
    this.satMesh?.geometry.dispose();

    this.renderer?.dispose();
  }
}