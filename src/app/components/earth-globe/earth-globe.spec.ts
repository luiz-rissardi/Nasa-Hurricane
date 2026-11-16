import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EarthGlobe } from './earth-globe';

describe('EarthGlobe', () => {
  let component: EarthGlobe;
  let fixture: ComponentFixture<EarthGlobe>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EarthGlobe],
    }).compileComponents();

    fixture = TestBed.createComponent(EarthGlobe);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
