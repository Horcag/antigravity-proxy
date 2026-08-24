import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectTypeScriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTypeScriptFiles(resolved);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [resolved] : [];
  });
}

describe('headless dependency boundary', () => {
  it('contains no Electron runtime imports', () => {
    const files = collectTypeScriptFiles(path.resolve(process.cwd(), 'src'));
    const offenders = files.filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return /from\s+['"]electron(?:\/[^'"]*)?['"]|require\(['"]electron/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
