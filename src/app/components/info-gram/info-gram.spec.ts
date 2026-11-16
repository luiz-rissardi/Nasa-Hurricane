import { ComponentFixture, TestBed } from '@angular/core/testing';
import { InfoGram } from './info-gram';

describe('InfoGram', () => {
  let component: InfoGram;
  let fixture: ComponentFixture<InfoGram>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InfoGram],
    }).compileComponents();

    fixture = TestBed.createComponent(InfoGram);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
