import { describe, expect, it } from 'vitest';
import {
  TECH_LEAD_PROFILES,
  isOnlineTechLeadInterview,
  techLeadProfileFor,
} from '../src/data/techLeadProfiles';

describe('tech lead profiles', () => {
  it('covers the seven applicants from the Tech Lead workbook', () => {
    expect(Object.keys(TECH_LEAD_PROFILES)).toHaveLength(7);
    expect(techLeadProfileFor('IAMSAJAL1408@gmail.com')?.fields.length).toBeGreaterThan(10);
  });

  it('tags the applicant missing from the workbook as an online interview', () => {
    expect(techLeadProfileFor('sh.kaustuv007@gmail.com')).toBeNull();
    expect(isOnlineTechLeadInterview('SH.Kaustuv007@gmail.com')).toBe(true);
    expect(isOnlineTechLeadInterview('adityagupta86548@gmail.com')).toBe(false);
  });
});
