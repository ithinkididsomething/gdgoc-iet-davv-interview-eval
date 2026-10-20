import { describe, expect, it } from 'vitest';
import {
  columnIndex,
  describeSheetsError,
  normalizeSpreadsheetId,
  parseSheetLink,
  sanitizeTabTitle,
  spreadsheetUrl,
} from '../src/services/sheets/googleSheets.js';
import { APPLICANT_EXPORT_HEADER } from '../src/services/sync-spreadsheet/engine.js';

const ID = '1hVKgXoxD4XrDQIey619gqlRfRtduVu5LqwzB5BmE4Bo';

describe('Google Sheets link helpers', () => {
  it('extracts the file id from share links with query strings', () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`)).toEqual({
      spreadsheetId: ID,
      gid: null,
    });
  });

  it('extracts the tab id from a gid fragment', () => {
    expect(parseSheetLink(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=123456789`)).toEqual({
      spreadsheetId: ID,
      gid: 123456789,
    });
  });

  it('accepts a bare file id', () => {
    expect(normalizeSpreadsheetId(ID)).toBe(ID);
  });

  it('keeps plain tab names unchanged', () => {
    expect(parseSheetLink('Tech Leads')).toEqual({ spreadsheetId: null, gid: null });
    expect(normalizeSpreadsheetId('Tech Leads')).toBe('Tech Leads');
  });

  it('builds canonical links from an id', () => {
    expect(spreadsheetUrl(ID)).toBe(`https://docs.google.com/spreadsheets/d/${ID}`);
  });

  it('surfaces the Google API message instead of a generic error', () => {
    expect(
      describeSheetsError({ response: { data: { error: { message: 'Sheets API is disabled' } } } }),
    ).toBe('Sheets API is disabled');
    expect(describeSheetsError(new Error('network down'))).toBe('network down');
    expect(describeSheetsError(null)).toBe('Google Sheets request failed');
  });
});

describe('Applicant export helpers', () => {
  it('sanitizes tab titles that Google rejects', () => {
    expect(sanitizeTabTitle('Tech/Leads: [A]')).toBe('Tech Leads A');
    expect(sanitizeTabTitle('   ')).toBe('Sheet');
    expect(sanitizeTabTitle('x'.repeat(140))).toHaveLength(100);
  });

  it('writes headers the importer and evaluation push can both read', () => {
    const key = columnIndex(APPLICANT_EXPORT_HEADER, ['roll_number']);
    const name = columnIndex(APPLICANT_EXPORT_HEADER, ['full_name', 'applicant_name']);
    expect(key).toBe(0);
    expect(name).toBe(1);
    for (const field of [
      'vertical',
      'completion',
      'final_average',
      'judge_count',
      'preferred_vertical_interview',
      'judge_remarks_interview',
    ]) {
      expect(columnIndex(APPLICANT_EXPORT_HEADER, [field])).not.toBeNull();
    }
    expect(new Set(APPLICANT_EXPORT_HEADER).size).toBe(APPLICANT_EXPORT_HEADER.length);
  });
});
