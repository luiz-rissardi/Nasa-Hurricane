/**
 * Escala de cores de temperatura (°C) — estilo earth.nullschool.net.
 * Para ajustar o visual, basta editar TEMP_STOPS (e TEMP_RANGE, se mudar os extremos).
 */

export type RGB = [number, number, number];

/** Faixa coberta pela escala. Valores fora dela são "travados" na primeira/última cor. */
export const TEMP_RANGE = { min: -50, max: 45 } as const;

/** Paradas de cor, em ordem crescente de temperatura. Adicione/remova paradas à vontade. */
const TEMP_STOPS: ReadonlyArray<{ temp: number; color: RGB }> = [
  { temp: -50, color: [245, 245, 255] }, // branco gelado (interior da Antártida)
  { temp: -40, color: [235, 130, 255] }, // magenta claro
  { temp: -30, color: [175,  65, 235] }, // roxo
  { temp: -20, color: [ 95,  75, 225] }, // violeta / índigo
  { temp: -10, color: [ 50, 135, 255] }, // azul
  { temp:   0, color: [ 40, 205, 240] }, // ciano
  { temp:   5, color: [ 55, 215, 175] }, // verde-água
  { temp:  10, color: [ 90, 205,  90] }, // verde
  { temp:  15, color: [170, 225,  70] }, // verde-amarelado
  { temp:  20, color: [245, 235,  60] }, // amarelo
  { temp:  25, color: [255, 180,  40] }, // laranja
  { temp:  30, color: [255, 110,  40] }, // laranja-avermelhado
  { temp:  35, color: [235,  40,  50] }, // vermelho
  { temp:  40, color: [190,  20,  90] }, // carmim
  { temp:  45, color: [140,  20, 130] }, // magenta escuro (calor extremo)
];

/** 1 / (max - min): permite trocar divisões por multiplicações nos laços quentes. */
export const TEMP_INV_RANGE = 1 / (TEMP_RANGE.max - TEMP_RANGE.min);

/** Inverso do tamanho de cada trecho da escala, calculado uma vez (evita uma divisão por chamada). */
const SEG_INV: number[] = TEMP_STOPS.map((s, i) =>
  i === 0 ? 0 : 1 / (s.temp - TEMP_STOPS[i - 1].temp)
);

/** Converte uma temperatura (°C) em RGB, interpolando linearmente entre as paradas. */
export function temperatureToRGB(temp: number): RGB {
  const value = Math.max(TEMP_RANGE.min, Math.min(TEMP_RANGE.max, temp));

  for (let i = 1; i < TEMP_STOPS.length; i++) {
    const b = TEMP_STOPS[i];
    if (value <= b.temp) {
      const a = TEMP_STOPS[i - 1];
      const t = (value - a.temp) * SEG_INV[i];
      return [
        Math.round(a.color[0] + (b.color[0] - a.color[0]) * t),
        Math.round(a.color[1] + (b.color[1] - a.color[1]) * t),
        Math.round(a.color[2] + (b.color[2] - a.color[2]) * t),
      ];
    }
  }

  return [...TEMP_STOPS[TEMP_STOPS.length - 1].color] as RGB;
}

/**
 * Paleta pré-calculada: `size` cores RGBA (Uint8Array de size × 4), do TEMP_RANGE.min ao max.
 * Vira uma textura 1D na GPU, que pinta a camada de temperatura sem nenhum laço por pixel no JS.
 * Cada entrada é exatamente temperatureToRGB(min + i/(size-1) · faixa), com alfa 255.
 */
export function temperatureLut(size = 512): Uint8Array {
  const lut = new Uint8Array(size * 4);
  const span = TEMP_RANGE.max - TEMP_RANGE.min;
  const inv = 1 / (size - 1);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = temperatureToRGB(TEMP_RANGE.min + i * inv * span);
    const o = i * 4;
    lut[o] = r;
    lut[o + 1] = g;
    lut[o + 2] = b;
    lut[o + 3] = 255;
  }
  return lut;
}

/**
 * Cor das partículas de vento no modo "temperatura".
 * t vai de 0 a 1 (0 = TEMP_RANGE.min, 1 = TEMP_RANGE.max).
 * A cor é clareada em direção ao branco para as linhas continuarem visíveis
 * por cima da camada térmica, que usa a mesma escala.
 */
export function particleTempColor(t: number, lighten = 0.55, alpha = 0.9): string {
  const temp = TEMP_RANGE.min + Math.min(1, Math.max(0, t)) * (TEMP_RANGE.max - TEMP_RANGE.min);
  const [r, g, b] = temperatureToRGB(temp);
  const mix = (c: number) => Math.round(c + (255 - c) * lighten);
  return `rgba(${mix(r)}, ${mix(g)}, ${mix(b)}, ${alpha})`;
}

// ───────────────────────── Helpers da legenda (HTML) ─────────────────────────

/** Cor CSS `rgb(r, g, b)` de uma temperatura (°C). */
export function temperatureCssColor(temp: number): string {
  const [r, g, b] = temperatureToRGB(temp);
  return `rgb(${r}, ${g}, ${b})`;
}

/** `linear-gradient` horizontal com as mesmas paradas (e posições) da escala. */
export function temperatureGradientCss(): string {
  const pct = 100 * TEMP_INV_RANGE;
  const parts = TEMP_STOPS.map(
    (s) => `rgb(${s.color.join(', ')}) ${((s.temp - TEMP_RANGE.min) * pct).toFixed(1)}%`
  );
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** Valores (°C) para os rótulos sob a barra de gradiente, igualmente espaçados. */
export function temperatureLegendTicks(count = 5): number[] {
  const span = TEMP_RANGE.max - TEMP_RANGE.min;
  return Array.from({ length: count }, (_, i) =>
    Math.round(TEMP_RANGE.min + (span * i) / (count - 1))
  );
}

/** Faixas descritivas da legenda; `color` sai da própria escala, então nunca desalinha. */
export function temperatureLegendBands(): { label: string; range: string; color: string }[] {
  const bands = [
    { label: 'Extreme cold', range: 'below -30 °C', sample: -40 },
    { label: 'Very cold', range: '-30 to -10 °C', sample: -20 },
    { label: 'Cold', range: '-10 to 5 °C', sample: 0 },
    { label: 'Mild', range: '5 to 20 °C', sample: 12 },
    { label: 'Warm', range: '20 to 30 °C', sample: 26 },
    { label: 'Very hot', range: 'above 30 °C', sample: 37 },
  ];
  return bands.map((b) => ({ label: b.label, range: b.range, color: temperatureCssColor(b.sample) }));
}

/** Célula da legenda compacta (uma por parada da escala). */
export interface LegendCell {
  temp: number;
  label: string;      // número exibido na célula
  color: string;      // cor de fundo (rgb)
  textColor: string;  // cor do número, escolhida pelo contraste com o fundo
}

/** Células para a legenda horizontal, do mais frio (esquerda) ao mais quente (direita). */
export function temperatureLegendCells(): LegendCell[] {
  return TEMP_STOPS.map(({ temp, color }) => {
    const [r, g, b] = color;
    const isLight = 0.299 * r + 0.587 * g + 0.114 * b > 150;
    return {
      temp,
      label: String(temp).replace('-', '−'),
      color: `rgb(${r}, ${g}, ${b})`,
      textColor: isLight ? '#0b1224' : '#ffffff',
    };
  });
}