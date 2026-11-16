/**
 * Escala de cores da pressão do ar (hPa) ao nível do mar.
 * Baixa pressão (tempo instável) em roxo/azul, ~1013 hPa em branco, alta pressão em laranja/vermelho.
 * Para ajustar o visual, edite PRESSURE_STOPS (e PRESSURE_RANGE, se mudar os extremos).
 */

type RGB = [number, number, number];

export const PRESSURE_RANGE = { min: 950, max: 1060 } as const;

/** 1 / (max - min): multiplicar no lugar de dividir. */
export const PRESSURE_INV_RANGE = 1 / (PRESSURE_RANGE.max - PRESSURE_RANGE.min);

const PRESSURE_STOPS: ReadonlyArray<{ hpa: number; color: RGB }> = [
  { hpa: 950,  color: [ 95,  45, 170] }, // violeta (ciclone profundo)
  { hpa: 970,  color: [ 60,  80, 215] }, // azul-escuro
  { hpa: 990,  color: [ 50, 150, 235] }, // azul
  { hpa: 1003, color: [ 70, 205, 205] }, // ciano
  { hpa: 1013, color: [235, 240, 235] }, // quase branco (pressão padrão)
  { hpa: 1022, color: [250, 225,  90] }, // amarelo
  { hpa: 1032, color: [250, 155,  50] }, // laranja
  { hpa: 1044, color: [225,  75,  50] }, // vermelho
  { hpa: 1060, color: [150,  30,  90] }, // carmim (anticiclone forte)
];

const SEG_INV: number[] = PRESSURE_STOPS.map((s, i) =>
  i === 0 ? 0 : 1 / (s.hpa - PRESSURE_STOPS[i - 1].hpa)
);

/** Converte uma pressão (hPa) em RGB, interpolando entre as paradas. */
export function pressureToRGB(hpa: number): RGB {
  const v = Math.max(PRESSURE_RANGE.min, Math.min(PRESSURE_RANGE.max, hpa));
  for (let i = 1; i < PRESSURE_STOPS.length; i++) {
    const b = PRESSURE_STOPS[i];
    if (v <= b.hpa) {
      const a = PRESSURE_STOPS[i - 1];
      const t = (v - a.hpa) * SEG_INV[i];
      return [
        Math.round(a.color[0] + (b.color[0] - a.color[0]) * t),
        Math.round(a.color[1] + (b.color[1] - a.color[1]) * t),
        Math.round(a.color[2] + (b.color[2] - a.color[2]) * t),
      ];
    }
  }
  return [...PRESSURE_STOPS[PRESSURE_STOPS.length - 1].color] as RGB;
}

/** Paleta pré-calculada (RGBA, `size` entradas) para virar textura 1D na GPU. */
export function pressureLut(size = 512): Uint8Array {
  const lut = new Uint8Array(size * 4);
  const span = PRESSURE_RANGE.max - PRESSURE_RANGE.min;
  const inv = 1 / (size - 1);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = pressureToRGB(PRESSURE_RANGE.min + i * inv * span);
    lut.set([r, g, b, 255], i * 4);
  }
  return lut;
}

/** `linear-gradient` horizontal com as mesmas paradas da escala (para a legenda). */
export function pressureGradientCss(): string {
  const pct = 100 * PRESSURE_INV_RANGE;
  const parts = PRESSURE_STOPS.map(
    (s) => `rgb(${s.color.join(', ')}) ${((s.hpa - PRESSURE_RANGE.min) * pct).toFixed(1)}%`
  );
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** Valores (hPa) para os rótulos da legenda, igualmente espaçados. */
export function pressureLegendTicks(count = 5): number[] {
  const span = PRESSURE_RANGE.max - PRESSURE_RANGE.min;
  return Array.from({ length: count }, (_, i) =>
    Math.round(PRESSURE_RANGE.min + (span * i) / (count - 1))
  );
}