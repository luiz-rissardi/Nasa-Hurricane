/**
 * Constrói o campo de vento/temperatura (grade regular lon/lat) a partir dos pontos da API.
 *
 * Mesmo resultado do algoritmo original, bem mais rápido:
 *  - Os pontos são organizados em "caixas" de 3° (índice espacial), então cada célula da grade
 *    só olha os pontos próximos, em vez de todos os N pontos.
 *  - Os K vizinhos mais próximos (IDW) saem de uma seleção direta (quickselect), sem a inserção
 *    ordenada que custava ~100 deslocamentos por ponto.
 *  - A temperatura (gaussiana) usa a separabilidade: o peso em latitude é calculado uma vez por
 *    (linha, ponto) e o peso em longitude ao longo da linha sai por recorrência
 *    (f[i+1] = f[i]·r[i], r[i+1] = r[i]·q) — duas multiplicações no lugar de um Math.exp por célula.
 *  - O trabalho é fatiado (~8 ms por vez) e devolve o controle ao navegador entre as fatias,
 *    então o globo continua desenhando e respondendo ao mouse durante o cálculo.
 */

export interface WindField {
  nx: number;
  ny: number;
  /** U, V e temperatura intercalados: [u0, v0, t0, u1, v1, t1, ...]. Mais rápido para amostrar. */
  uvt: Float32Array;
  /** Pressão (hPa) — NaN onde não há dado. */
  p: Float32Array;
  /** Umidade relativa (%) — NaN onde não há dado. */
  h: Float32Array;
}

export interface WindFieldOptions {
  step: number;              // resolução da grade, em graus
  idwNeighbors: number;      // nº de vizinhos do IDW (vento, pressão, umidade)
  tempSigmaLat: number;      // suavização gaussiana de temperatura/pressão/umidade (graus de latitude)
  tempSigmaLon: number;      // suavização gaussiana de temperatura/pressão/umidade (graus de longitude)
  sliceMs?: number;          // quanto tempo trabalhar antes de devolver o controle (padrão 8 ms)
  isCancelled?: () => boolean;
}

const D2R = Math.PI / 180;
const SPHERE_DEG2 = 41252.96;     // área da esfera em graus²
const BIN = 3;                    // tamanho da caixa do índice espacial (graus)
const INV_BIN = 1 / BIN;

/** Converte para número tratando null/undefined/'' como "sem dado" (Number(null) daria 0). */
const num = (x: unknown): number =>
  x === null || x === undefined || x === '' ? NaN : Number(x);

/** Devolve o controle ao navegador sem o atraso mínimo de ~4 ms do setTimeout. */
function yieldToMain(): Promise<void> {
  const sched = (globalThis as any).scheduler;
  if (sched && typeof sched.yield === 'function') return sched.yield();
  return new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

/** k-ésimo menor valor de a[0..n) (quickselect). Reordena `a`. */
function selectKth(a: Float64Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i]; a[i] = a[j]; a[j] = t;
        i++; j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}

export async function buildWindField(locations: any[], opts: WindFieldOptions): Promise<WindField | null> {
  const sliceMs = opts.sliceMs ?? 8;

  // ── 1) Extrai os pontos válidos ────────────────────────────────────────────
  const cap = locations.length;
  const pLat = new Float64Array(cap), pLon = new Float64Array(cap);
  const pU = new Float32Array(cap), pV = new Float32Array(cap), pT = new Float32Array(cap);
  const pP = new Float32Array(cap), pH = new Float32Array(cap);
  let N = 0;

  for (const loc of locations) {
    const lat = num(loc?.latitude);
    const lon = num(loc?.longitude);
    const speed = num(loc?.current?.wind_speed_10m);
    const dir = num(loc?.current?.wind_direction_10m);
    const temp = num(loc?.current?.temperature_2m);
    if (![lat, lon, speed, dir, temp].every(Number.isFinite)) continue;

    // wind_direction_10m = de ONDE o vento vem; u/v = para ONDE ele vai
    const rad = dir * D2R;
    pLat[N] = lat;
    pLon[N] = ((lon + 180) % 360 + 360) % 360 - 180;
    pU[N] = -speed * Math.sin(rad);   // leste(+)
    pV[N] = -speed * Math.cos(rad);   // norte(+)
    pT[N] = temp;
    pP[N] = num(loc?.current?.pressure_msl ?? loc?.current?.surface_pressure);   // NaN se não vier
    pH[N] = num(loc?.current?.relative_humidity_2m);
    N++;
  }
  if (!N) return null;

  // ── 2) Índice espacial: caixas de 3° em formato CSR (contagem + soma acumulada) ─
  const nbx = Math.round(360 * INV_BIN);
  const nby = Math.round(180 * INV_BIN);
  const nb = nbx * nby;
  const binStart = new Int32Array(nb + 1);
  const binOf = new Int32Array(N);

  for (let p = 0; p < N; p++) {
    let bx = Math.floor((pLon[p] + 180) * INV_BIN);
    let by = Math.floor((pLat[p] + 90) * INV_BIN);
    if (bx >= nbx) bx = nbx - 1; else if (bx < 0) bx = 0;
    if (by >= nby) by = nby - 1; else if (by < 0) by = 0;
    const b = by * nbx + bx;
    binOf[p] = b;
    binStart[b + 1]++;
  }
  for (let b = 0; b < nb; b++) binStart[b + 1] += binStart[b];

  // Cópias ordenadas por caixa: pontos vizinhos ficam juntos na memória
  const cursor = binStart.slice(0, nb);
  const sIdx = new Int32Array(N);            // posição original de cada ponto (desempate idêntico ao algoritmo antigo)
  const sLat = new Float64Array(N), sLon = new Float64Array(N);
  const sU = new Float32Array(N), sV = new Float32Array(N), sT = new Float32Array(N);
  const sP = new Float32Array(N), sH = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const k = cursor[binOf[p]]++;
    sIdx[k] = p;
    sLat[k] = pLat[p]; sLon[k] = pLon[p];
    sU[k] = pU[p]; sV[k] = pV[p]; sT[k] = pT[p]; sP[k] = pP[p]; sH[k] = pH[p];
  }

  // ── 3) Grade de saída ──────────────────────────────────────────────────────
  const step = opts.step;
  const nx = Math.round(360 / step);
  const ny = Math.round(180 / step) + 1;
  const uvt = new Float32Array(nx * ny * 3);
  const P = new Float32Array(nx * ny);
  const H = new Float32Array(nx * ny);

  const K = Math.min(opts.idwNeighbors, N);
  const candIdx = new Int32Array(N);
  const candD2 = new Float64Array(N);
  const tmpD2 = new Float64Array(N);

  // Gaussiana da temperatura (1/(2σ²) já invertido: multiplicar é mais barato que dividir)
  const invS2Lat = 1 / (2 * opts.tempSigmaLat * opts.tempSigmaLat);
  const invS2Lon = 1 / (2 * opts.tempSigmaLon * opts.tempSigmaLon);
  const cutLat = 3 * opts.tempSigmaLat;      // além de 3σ o peso é desprezível
  const cutLon = 3 * opts.tempSigmaLon;

  // Raio inicial de busca: o esperado para ter K pontos se estivessem espalhados por igual
  let radius = Math.sqrt((K * SPHERE_DEG2) / (Math.PI * N)) * 1.25;

  // Faixa de caixas em longitude a varrer (preenchida por setLonBins)
  let bx0 = 0, bxn = nbx;
  const setLonBins = (lon: number, dLonMax: number): void => {
    if (dLonMax >= 180) { bx0 = 0; bxn = nbx; return; }
    const a = Math.floor((lon - dLonMax + 180) * INV_BIN);
    const n = Math.floor((lon + dLonMax + 180) * INV_BIN) - a + 1;
    if (n >= nbx) { bx0 = 0; bxn = nbx; } else { bx0 = a; bxn = n; }
  };

  /** Reúne todos os pontos a distância ≤ rad (métrica com lon × cos(lat) da linha). Devolve a contagem. */
  const collect = (lat: number, lon: number, c: number, rad: number): number => {
    const r2 = rad * rad;
    let by0 = Math.floor((lat - rad + 90) * INV_BIN);
    let by1 = Math.floor((lat + rad + 90) * INV_BIN);
    if (by0 < 0) by0 = 0;
    if (by1 > nby - 1) by1 = nby - 1;
    setLonBins(lon, rad / c);

    let m = 0;
    for (let by = by0; by <= by1; by++) {
      const rowBase = by * nbx;
      for (let q = 0; q < bxn; q++) {
        let bx = bx0 + q;
        if (bx < 0) bx += nbx; else if (bx >= nbx) bx -= nbx;
        const b = rowBase + bx;
        for (let k = binStart[b], e = binStart[b + 1]; k < e; k++) {
          const dLat = sLat[k] - lat;
          let dLon = sLon[k] - lon;
          if (dLon < 0) dLon = -dLon;
          if (dLon > 180) dLon = 360 - dLon;       // atravessa o antimeridiano
          dLon *= c;
          const d2 = dLat * dLat + dLon * dLon;
          if (d2 <= r2) { candIdx[m] = k; candD2[m] = d2; m++; }
        }
      }
    }
    return m;
  };

  // Acumuladores da gaussiana para UMA linha da grade (peso total e peso × temperatura)
  const accW = new Float64Array(nx);
  const accT = new Float64Array(nx);
  const accWp = new Float64Array(nx);   // pressão e umidade: só entram os pontos que têm o dado
  const accP = new Float64Array(nx);
  const accWh = new Float64Array(nx);
  const accH = new Float64Array(nx);
  const invStep = 1 / step;
  const step2 = step * step;

  /**
   * Gaussiana da temperatura para a linha de latitude `lat`, para todas as colunas de uma vez.
   * Para cada ponto: wLat = exp(-dLat²/2σlat²) (um exp) e, ao longo das colunas,
   * f(i) = wLat·exp(-ac·Δ(i)²) com Δ(i+1) = Δ(i) + step, então f(i+1) = f(i)·r(i) e r(i+1) = r(i)·q.
   */
  const gaussianRow = (lat: number, c: number): void => {
    accW.fill(0);
    accT.fill(0);
    accWp.fill(0);
    accP.fill(0);
    accWh.fill(0);
    accH.fill(0);

    let by0 = Math.floor((lat - cutLat + 90) * INV_BIN);
    let by1 = Math.floor((lat + cutLat + 90) * INV_BIN);
    if (by0 < 0) by0 = 0;
    if (by1 > nby - 1) by1 = nby - 1;

    const halfW = cutLon / c;                  // meia-janela em longitude (graus de longitude)
    const wide = halfW >= 180;                 // perto dos polos a janela dá a volta no globo
    const ac = invS2Lon * c * c;
    const q = Math.exp(-2 * ac * step2);

    // As caixas estão em ordem (linha, coluna): as linhas by0..by1 formam um trecho contíguo
    for (let k = binStart[by0 * nbx], e = binStart[(by1 + 1) * nbx]; k < e; k++) {
      const dLat = sLat[k] - lat;
      if (dLat >= cutLat || dLat <= -cutLat) continue;
      const wLat = Math.exp(-(dLat * dLat) * invS2Lat);
      const L = sLon[k];
      const T = sT[k];
      const Pv = sP[k], Hv = sH[k];
      const hasP = Pv === Pv, hasH = Hv === Hv;

      if (wide) {
        for (let i = 0; i < nx; i++) {
          let dLon = L - (-180 + i * step);
          if (dLon < 0) dLon = -dLon;
          if (dLon > 180) dLon = 360 - dLon;
          dLon *= c;
          if (dLon >= cutLon) continue;
          const wt = wLat * Math.exp(-(dLon * dLon) * invS2Lon);
          accW[i] += wt;
          accT[i] += wt * T;
          if (hasP) { accWp[i] += wt; accP[i] += wt * Pv; }
          if (hasH) { accWh[i] += wt; accH[i] += wt * Hv; }
        }
        continue;
      }

      // Colunas com |Δlon|·c < cutLon (desigualdade estrita, como no original)
      const i0 = Math.floor((L - halfW + 180) * invStep) + 1;
      const i1 = Math.ceil((L + halfW + 180) * invStep) - 1;
      if (i1 < i0) continue;

      const d0 = -180 + step * i0 - L;
      let f = wLat * Math.exp(-ac * d0 * d0);
      let r = Math.exp(-ac * (2 * d0 * step + step2));
      for (let i = i0; i <= i1; i++) {
        const idx = i < 0 ? i + nx : i >= nx ? i - nx : i;
        accW[idx] += f;
        accT[idx] += f * T;
        if (hasP) { accWp[idx] += f; accP[idx] += f * Pv; }
        if (hasH) { accWh[idx] += f; accH[idx] += f * Hv; }
        f *= r;
        r *= q;
      }
    }
  };

  // ── 4) Preenche a grade, fatiando o trabalho ───────────────────────────────
  let sliceStart = performance.now();

  for (let j = 0; j < ny; j++) {
    const lat = -90 + j * step;
    const c = Math.max(Math.cos(lat * D2R), 0.05);
    gaussianRow(lat, c);

    for (let i = 0; i < nx; i++) {
      const lon = -180 + i * step;

      // K vizinhos mais próximos. Se o raio não alcançou K pontos, aumenta e repete.
      let m = collect(lat, lon, c, radius);
      while (m < K) { radius *= 1.6; m = collect(lat, lon, c, radius); }

      // Distância (²) do K-ésimo vizinho; com m === K todos entram.
      // Empates exatamente na distância do K-ésimo (comuns em grades regulares) são resolvidos
      // pelo índice original do ponto, como no algoritmo antigo: o resultado fica idêntico.
      let kth = Infinity, tieCut = Infinity;
      if (m > K) {
        for (let q = 0; q < m; q++) tmpD2[q] = candD2[q];
        kth = selectKth(tmpD2, m, K - 1);

        let less = 0, ties = 0;
        for (let q = 0; q < m; q++) {
          const d2 = candD2[q];
          if (d2 < kth) less++; else if (d2 === kth) ties++;
        }
        const need = K - less;
        if (ties > need) {
          let t = 0;
          for (let q = 0; q < m; q++) if (candD2[q] === kth) tmpD2[t++] = sIdx[candIdx[q]];
          tieCut = selectKth(tmpD2, t, need - 1);
        }
      }

      let sw = 0, su = 0, sv = 0, st = 0, swp = 0, sp = 0, swh = 0, sh = 0, dmax = 0;
      for (let q = 0; q < m; q++) {
        const d2 = candD2[q];
        if (d2 > kth) continue;
        const k = candIdx[q];
        if (d2 === kth && sIdx[k] > tieCut) continue;
        if (d2 > dmax) dmax = d2;
        const w = 1 / (d2 + 0.25);
        sw += w;
        su += w * sU[k];
        sv += w * sV[k];
        st += w * sT[k];
        // pressão/umidade: média só entre os vizinhos que têm o dado
        const pv = sP[k], hv = sH[k];
        if (pv === pv) { swp += w; sp += w * pv; }
        if (hv === hv) { swh += w; sh += w * hv; }
      }

      // A célula vizinha tem densidade parecida: usa a distância do K-ésimo como próximo raio
      radius = Math.sqrt(dmax) * 1.15 + 0.05;

      const inv = 1 / sw;
      const o = j * nx + i;
      const o3 = o * 3;
      uvt[o3] = su * inv;
      uvt[o3 + 1] = sv * inv;

      // Temperatura: gaussiana suave; sem ponto por perto (ex.: polos), cai no IDW
      uvt[o3 + 2] = accW[i] > 0 ? accT[i] / accW[i] : st * inv;

      // Pressão e umidade: mesma gaussiana (campo suave, sem "bolhas" em volta de cada ponto);
      // sem ponto por perto, cai na média por IDW
      P[o] = accWp[i] > 0 ? accP[i] / accWp[i] : swp ? sp / swp : NaN;
      H[o] = accWh[i] > 0 ? accH[i] / accWh[i] : swh ? sh / swh : NaN;
    }

    // Devolve o controle ao navegador para ele desenhar/responder entre as fatias
    if (performance.now() - sliceStart > sliceMs) {
      await yieldToMain();
      if (opts.isCancelled?.()) return null;
      sliceStart = performance.now();
    }
  }

  return { nx, ny, uvt, p: P, h: H };
}