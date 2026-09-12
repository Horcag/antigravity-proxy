import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXIT_CRITICAL,
  EXIT_OK,
  EXIT_POLICY_ERROR,
  BaselineUpdateError,
  PolicyConfigurationError,
  buildReducedBaseline,
  countPhysicalLines,
  discoverSourceFiles,
  evaluateFileSizes,
  loadBaseline,
  loadConfig,
  matchesAnyGlob,
  matchesGlob,
  validateThresholds,
  Thresholds,
} from '../../../scripts/quality/file-size-policy';

describe('file-size policy ratchet engine', () => {
  const defaultThresholds: Thresholds = {
    warning_above: 350,
    error_above: 500,
    critical_above: 1000,
  };

  describe('threshold validation', () => {
    it('accepts valid ascending positive thresholds', () => {
      expect(() => validateThresholds(defaultThresholds)).not.toThrow();
    });

    it('rejects non-positive warning threshold', () => {
      expect(() =>
        validateThresholds({ warning_above: 0, error_above: 500, critical_above: 1000 }),
      ).toThrow(PolicyConfigurationError);
    });

    it('rejects inverted warning/error thresholds', () => {
      expect(() =>
        validateThresholds({ warning_above: 600, error_above: 500, critical_above: 1000 }),
      ).toThrow(PolicyConfigurationError);
    });

    it('rejects inverted error/critical thresholds', () => {
      expect(() =>
        validateThresholds({ warning_above: 350, error_above: 1000, critical_above: 800 }),
      ).toThrow(PolicyConfigurationError);
    });
  });

  describe('physical line counting', () => {
    it('counts lines including blanks and comments accurately', () => {
      const selfPath = path.resolve(__dirname, 'file-size-policy.test.ts');
      const lines = countPhysicalLines(selfPath);
      expect(lines).toBeGreaterThan(50);
      expect(lines).toBeLessThan(500);
    });
  });

  describe('glob matching', () => {
    it('matches directory globs', () => {
      expect(matchesGlob('node_modules/pkg/index.js', '**/node_modules/**')).toBe(true);
      expect(matchesGlob('src/node_modules/pkg.ts', '**/node_modules/**')).toBe(true);
      expect(matchesGlob('src/app/index.ts', '**/node_modules/**')).toBe(false);
    });

    it('matches prefix and suffix globs', () => {
      expect(matchesGlob('dist/bundle.js', '**/dist/**')).toBe(true);
      expect(matchesGlob('src/file.test.ts', '**/*.test.ts')).toBe(true);
    });

    it('matches any glob from list', () => {
      const exclusions = ['**/dist/**', '**/coverage/**', '**/.git/**'];
      expect(matchesAnyGlob('coverage/lcov.info', exclusions)).toBe(true);
      expect(matchesAnyGlob('src/index.ts', exclusions)).toBe(false);
    });
  });

  describe('file size evaluation and ratchet rules', () => {
    it('permits unbaselined files within normal limit (<= 350)', () => {
      const files = { 'src/clean.ts': 300 };
      const baseline = {};
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_OK);
      expect(result.findings).toHaveLength(0);
    });

    it('permits unbaselined files in warning range (351-500) as non-blocking', () => {
      const files = { 'src/warning.ts': 400 };
      const baseline = {};
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_OK);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        path: 'src/warning.ts',
        lines: 400,
        severity: 'warning',
        status: 'new-warning',
        blocking: false,
      });
    });

    it('blocks unbaselined files exceeding error threshold (> 500) with EXIT_POLICY_ERROR', () => {
      const files = { 'src/oversized.ts': 600 };
      const baseline = {};
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_POLICY_ERROR);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        path: 'src/oversized.ts',
        lines: 600,
        severity: 'error',
        status: 'new-debt',
        blocking: true,
      });
    });

    it('blocks unbaselined files exceeding critical threshold (> 1000) with EXIT_CRITICAL', () => {
      const files = { 'src/huge.ts': 1200 };
      const baseline = {};
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_CRITICAL);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        path: 'src/huge.ts',
        lines: 1200,
        severity: 'critical',
        status: 'new-debt',
        blocking: true,
      });
    });

    it('permits legacy grandfathered files if line count is unchanged', () => {
      const files = { 'src/legacy.ts': 800 };
      const baseline = { 'src/legacy.ts': 800 };
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_OK);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        path: 'src/legacy.ts',
        lines: 800,
        baseline_lines: 800,
        severity: 'error',
        status: 'baselined',
        blocking: false,
      });
    });

    it('blocks legacy files if line count grows even by 1 line (ratchet)', () => {
      const files = { 'src/legacy.ts': 801 };
      const baseline = { 'src/legacy.ts': 800 };
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_POLICY_ERROR);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        path: 'src/legacy.ts',
        lines: 801,
        baseline_lines: 800,
        severity: 'error',
        status: 'regression',
        blocking: true,
      });
      expect(result.findings[0].message).toContain('Legacy debt grew by 1 lines');
    });

    it('requires ratchet update when legacy files reduce line count (baseline-reduced is blocking)', () => {
      const files = { 'src/legacy.ts': 650 };
      const baseline = { 'src/legacy.ts': 800 };
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_POLICY_ERROR);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        path: 'src/legacy.ts',
        lines: 650,
        baseline_lines: 800,
        status: 'baseline-reduced',
        blocking: true,
      });

      // Once baseline is ratcheted down via buildReducedBaseline, evaluateFileSizes passes
      const reduced = buildReducedBaseline(files, baseline, defaultThresholds);
      expect(reduced['src/legacy.ts']).toBe(650);
      const ratchetedResult = evaluateFileSizes(files, reduced, defaultThresholds);
      expect(ratchetedResult.exit_code).toBe(EXIT_OK);
    });

    it('reports blocking baseline-removed when a legacy file is deleted or refactored away', () => {
      const files = {};
      const baseline = { 'src/deleted.ts': 900 };
      const result = evaluateFileSizes(files, baseline, defaultThresholds);

      expect(result.exit_code).toBe(EXIT_POLICY_ERROR);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        path: 'src/deleted.ts',
        status: 'baseline-removed',
        blocking: true,
      });

      // Once baseline is ratcheted down, deleted file is removed and check passes
      const reduced = buildReducedBaseline(files, baseline, defaultThresholds);
      expect(reduced['src/deleted.ts']).toBeUndefined();
      const ratchetedResult = evaluateFileSizes(files, reduced, defaultThresholds);
      expect(ratchetedResult.exit_code).toBe(EXIT_OK);
    });
  });

  describe('baseline ratchet reduction (buildReducedBaseline)', () => {
    it('lowers cap when a legacy file shrinks', () => {
      const files = { 'src/legacy.ts': 700 };
      const baseline = { 'src/legacy.ts': 800 };
      const reduced = buildReducedBaseline(files, baseline, defaultThresholds);

      expect(reduced).toEqual({ 'src/legacy.ts': 700 });
    });

    it('removes file from baseline when it shrinks below error threshold (<= 500)', () => {
      const files = { 'src/legacy.ts': 450 };
      const baseline = { 'src/legacy.ts': 800 };
      const reduced = buildReducedBaseline(files, baseline, defaultThresholds);

      expect(reduced).toEqual({});
    });

    it('removes file from baseline when it is deleted', () => {
      const files = {};
      const baseline = { 'src/legacy.ts': 800 };
      const reduced = buildReducedBaseline(files, baseline, defaultThresholds);

      expect(reduced).toEqual({});
    });

    it('rejects baseline update when legacy file grew (anti-expansion)', () => {
      const files = { 'src/legacy.ts': 850 };
      const baseline = { 'src/legacy.ts': 800 };

      expect(() => buildReducedBaseline(files, baseline, defaultThresholds)).toThrow(
        BaselineUpdateError,
      );
    });

    it('rejects baseline update when new oversized file was introduced', () => {
      const files = { 'src/legacy.ts': 800, 'src/new-huge.ts': 950 };
      const baseline = { 'src/legacy.ts': 800 };

      expect(() => buildReducedBaseline(files, baseline, defaultThresholds)).toThrow(
        BaselineUpdateError,
      );
    });
  });

  describe('active repository integration', () => {
    it('passes cleanly on current repo files without any blocking violations', () => {
      const repoRoot = path.resolve(__dirname, '../../..');
      const config = loadConfig(path.join(repoRoot, 'quality/file-size-policy.json'));
      const baseline = loadBaseline(path.join(repoRoot, config.baseline_path));
      const discovered = discoverSourceFiles(repoRoot, config);

      const result = evaluateFileSizes(discovered, baseline, config.thresholds);
      expect(result.exit_code).toBe(EXIT_OK);
      const blocking = result.findings.filter((f) => f.blocking);
      expect(blocking).toHaveLength(0);
    });
  });
});
