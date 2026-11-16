import { TestBed } from '@angular/core/testing';
import { GlobeFacade } from './globe-facade';

describe('GlobeFacade', () => {
  let service: GlobeFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(GlobeFacade);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
