import { computed, Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class WeatherState {
  selectedWeather = signal<any | null>(null);
  selectedAstronomy = signal<any | null>(null);
  selectedHourly = signal<any[]>([]);
  selectedAirQuality = signal<any | null>(null); // Novo signal para a qualidade do ar

  readonly weatherState = computed(() => {
    return { 
      astronomia: this.selectedAstronomy(), 
      clima: this.selectedWeather(),
      hourly: this.selectedHourly(),
      qualidadeAr: this.selectedAirQuality() // Exposto no computed unificado
    };
  });
}