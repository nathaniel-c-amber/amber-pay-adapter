import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// Jest runs with cwd = server/, so the migrations live under src/db/migrations.
const migrationsDir = path.join(process.cwd(), 'src', 'db', 'migrations');

/** Column/concept names that must never appear in the schema (FR-2.3/FR-5.2). */
const FORBIDDEN = [
  'amount',
  'currency',
  'card',
  'card_number',
  'cvv',
  'pan',
  'ssn',
  'iban',
  'customer',
  'balance',
  'price',
  'salary',
];

/** Drop `--` comment lines so documentation may still mention the words. */
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .toLowerCase();
}

describe('migrations privacy', () => {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql'));

  it('ships at least one migration', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never declares financial or PII columns', () => {
    for (const file of files) {
      const sql = withoutComments(readFileSync(path.join(migrationsDir, file), 'utf8'));
      for (const key of FORBIDDEN) {
        expect(sql).not.toMatch(new RegExp(`\\b${key}\\b`));
      }
    }
  });
});
