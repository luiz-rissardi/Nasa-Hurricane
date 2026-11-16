import { ChangeDetectionStrategy, Component } from '@angular/core';
import { temperatureLegendCells } from '../earth-globe/temperature-scale';

/** Legenda compacta de temperatura (°C), em linha horizontal, no canto inferior direito do globo. */
@Component({
  selector: 'app-temperature-legend',
  templateUrl: './temperature-legend.html',
  styleUrl: './temperature-legend.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class TemperatureLegend {
  // Gerada da mesma escala usada no globo: se você mudar uma cor lá, a legenda acompanha
  protected readonly cells = temperatureLegendCells();
}