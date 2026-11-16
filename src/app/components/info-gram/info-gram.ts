import { Component, inject } from '@angular/core';
import { WeatherState } from '../../states/weather-state';
import { SlicePipe } from '@angular/common';

@Component({
  imports: [SlicePipe],
  selector: 'app-info-gram',
  styleUrl: './info-gram.scss',
  templateUrl: './info-gram.html',
})
export class InfoGram {

  protected weatherState = inject(WeatherState);

  getMoonPhaseName(phase: number): string {
    if (phase === 0 || phase === 1) return 'Lua Nova 🌑';
    if (phase > 0 && phase < 0.25) return 'Lua Crescente Côncava 🌒';
    if (phase === 0.25) return 'Quarto Crescente 🌓';
    if (phase > 0.25 && phase < 0.5) return 'Lua Crescente Gibosa 🌔';
    if (phase === 0.5) return 'Lua Cheia 🌕';
    if (phase > 0.5 && phase < 0.75) return 'Lua Minguante Gibosa 🌖';
    if (phase === 0.75) return 'Quarto Minguante 🌗';
    if (phase > 0.75 && phase < 1) return 'Lua Minguante Côncava 🌘';
    return `Fase (${phase})`;
  }

  getAirQualityDescription(aqi: number): { text: string, color: string } {
    if (aqi <= 20) return { text: 'Boa 🟢', color: '#34d399' };
    if (aqi <= 40) return { text: 'Razoável 🟡', color: '#facc15' };
    if (aqi <= 60) return { text: 'Moderada 🟠', color: '#fb923c' };
    if (aqi <= 80) return { text: 'Ruim 🔴', color: '#f87171' };
    if (aqi <= 100) return { text: 'muito ruim 🟣', color: '#c084fc' };
    return { text: 'extremamente ruim ⚫', color: '#a855f7' };
  }
}
