import { TestBed } from '@angular/core/testing';
import { GlobeData } from './globe-data';

describe('GlobeData', () => {
  let service: GlobeData;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GlobeData);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
