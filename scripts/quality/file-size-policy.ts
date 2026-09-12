import * as fs from 'node:fs';
import * as path from 'node:path';

export const EXIT_OK = 0;
export const EXIT_POLICY_ERROR = 1;
export const EXIT_CRITICAL = 2;
export const EXIT_CONFIGURATION_ERROR = 3;

export class PolicyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConfigurationError';
  }
}

export class BaselineUpdateError extends Error {
  public exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'BaselineUpdateError';
    this.exitCode = exitCode;
  }
}

export interface Thresholds {
  warning_above: number;
  error_above: number;
  critical_above: number;
}

export function validateThresholds(thresholds: Thresholds): void {
  if (
    !(
      thresholds.warning_above > 0 &&
      thresholds.warning_above < thresholds.error_above &&
      thresholds.error_above < thresholds.critical_above
    )
  ) {
    throw new PolicyConfigurationError('Expected 0 < warning_above < error_above < critical_above');
  }
}

export interface PolicyConfig {
  schema_version: number;
  baseline_path: string;
  thresholds: Thresholds;
  source_roots: string[];
  extensions: string[];
  excluded_globs: string[];
}

export interface Finding {
  path: string;
  lines: number;
  severity: 'warning' | 'error' | 'critical';
  status: 'baselined' | 'baseline-reduced' | 'baseline-removed' | 'regression' | 'new-warning' | 'new-debt';
  blocking: boolean;
  message: string;
  baseline_lines?: number;
}

export interface PolicySummary {
  scanned_files: number;
  findings: number;
  warnings: number;
  errors: number;
  critical: number;
  blocking: number;
}

export interface PolicyResult {
  findings: Finding[];
  exit_code: number;
  summary: (scannedFiles: number) => PolicySummary;
}

export function countPhysicalLines(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  // Count physical lines by splitting on newline
  return content.split(/\r?\n/).length;
}

export function globToRegex(pattern: string): RegExp {
  let regexStr = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (c === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (c === '?') {
      regexStr += '[^/]';
      i++;
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(c)) {
      regexStr += `\\${c}`;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

export function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/');
  return globToRegex(pattern).test(normalized);
}

export function matchesAnyGlob(relativePath: string, excludedGlobs: string[]): boolean {
  return excludedGlobs.some((pattern) => matchesGlob(relativePath, pattern));
}

export function discoverSourceFiles(
  repoRoot: string,
  config: PolicyConfig,
): Record<string, number> {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const allowedExtensions = new Set(config.extensions.map((e) => e.toLowerCase()));
  const discovered: Record<string, number> = {};

  for (const sourceRoot of config.source_roots) {
    const resolvedSourceRoot = path.resolve(resolvedRepoRoot, sourceRoot);
    if (!fs.existsSync(resolvedSourceRoot) || !fs.statSync(resolvedSourceRoot).isDirectory()) {
      continue;
    }

    const walk = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relativePosix = path.relative(resolvedRepoRoot, fullPath).replaceAll('\\', '/');

        if (matchesAnyGlob(relativePosix, config.excluded_globs)) {
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && !entry.isSymbolicLink()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (allowedExtensions.has(ext)) {
            discovered[relativePosix] = countPhysicalLines(fullPath);
          }
        }
      }
    };

    walk(resolvedSourceRoot);
  }

  return Object.fromEntries(Object.entries(discovered).sort(([a], [b]) => a.localeCompare(b)));
}

function sizeSeverity(lineCount: number, thresholds: Thresholds): 'warning' | 'error' | 'critical' | null {
  if (lineCount > thresholds.critical_above) return 'critical';
  if (lineCount > thresholds.error_above) return 'error';
  if (lineCount > thresholds.warning_above) return 'warning';
  return null;
}

export function evaluateFileSizes(
  files: Record<string, number>,
  baseline: Record<string, number>,
  thresholds: Thresholds,
): PolicyResult {
  validateThresholds(thresholds);
  const findings: Finding[] = [];

  for (const [filePath, lineCount] of Object.entries(files)) {
    const baselineLines = baseline[filePath];

    if (baselineLines !== undefined) {
      if (lineCount === baselineLines) {
        findings.push({
          path: filePath,
          lines: lineCount,
          baseline_lines: baselineLines,
          severity: sizeSeverity(lineCount, thresholds) || 'warning',
          status: 'baselined',
          blocking: false,
          message: 'Legacy debt is unchanged',
        });
      } else if (lineCount > baselineLines) {
        const severity = lineCount > thresholds.critical_above ? 'critical' : 'error';
        findings.push({
          path: filePath,
          lines: lineCount,
          baseline_lines: baselineLines,
          severity,
          status: 'regression',
          blocking: true,
          message: `Legacy debt grew by ${lineCount - baselineLines} lines (cap: ${baselineLines})`,
        });
      } else {
        findings.push({
          path: filePath,
          lines: lineCount,
          baseline_lines: baselineLines,
          severity: sizeSeverity(lineCount, thresholds) || 'warning',
          status: 'baseline-reduced',
          blocking: false,
          message: `Legacy debt was reduced by ${baselineLines - lineCount} lines`,
        });
      }
      continue;
    }

    const severity = sizeSeverity(lineCount, thresholds);
    if (severity !== null) {
      const blocking = severity === 'error' || severity === 'critical';
      findings.push({
        path: filePath,
        lines: lineCount,
        severity,
        status: severity === 'warning' ? 'new-warning' : 'new-debt',
        blocking,
        message:
          severity === 'warning'
            ? `New or unbaselined file has ${lineCount} physical lines (approaching ${thresholds.error_above} limit, warn > ${thresholds.warning_above})`
            : `New or unbaselined file has ${lineCount} physical lines (exceeds ${thresholds.error_above} limit)`,
      });
    }
  }

  for (const [baselinePath, baselineLines] of Object.entries(baseline)) {
    if (files[baselinePath] === undefined) {
      findings.push({
        path: baselinePath,
        lines: 0,
        baseline_lines: baselineLines,
        severity: 'warning',
        status: 'baseline-removed',
        blocking: false,
        message: 'Legacy debt file was removed or left the configured source roots',
      });
    }
  }

  const blockingFindings = findings.filter((f) => f.blocking);
  let exit_code = EXIT_OK;
  if (blockingFindings.some((f) => f.severity === 'critical')) {
    exit_code = EXIT_CRITICAL;
  } else if (blockingFindings.length > 0) {
    exit_code = EXIT_POLICY_ERROR;
  }

  return {
    findings,
    exit_code,
    summary: (scannedFiles: number): PolicySummary => ({
      scanned_files: scannedFiles,
      findings: findings.length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      errors: findings.filter((f) => f.severity === 'error').length,
      critical: findings.filter((f) => f.severity === 'critical').length,
      blocking: blockingFindings.length,
    }),
  };
}

export function buildReducedBaseline(
  files: Record<string, number>,
  baseline: Record<string, number>,
  thresholds: Thresholds,
): Record<string, number> {
  const result = evaluateFileSizes(files, baseline, thresholds);
  const unsafe = result.findings.filter((f) => f.status === 'regression' || f.status === 'new-debt');

  if (unsafe.length > 0) {
    const paths = unsafe.map((f) => f.path).join(', ');
    const exitCode = unsafe.some((f) => f.severity === 'critical') ? EXIT_CRITICAL : EXIT_POLICY_ERROR;
    throw new BaselineUpdateError(
      `Refusing to baseline new or increased debt: ${paths}`,
      exitCode,
    );
  }

  const reduced: Record<string, number> = {};
  for (const baselinePath of Object.keys(baseline).sort()) {
    const currentLines = files[baselinePath];
    // Retain only if file still exists and exceeds error threshold
    if (currentLines !== undefined && currentLines > thresholds.error_above) {
      reduced[baselinePath] = currentLines;
    }
  }

  return reduced;
}

export function loadConfig(configPath: string): PolicyConfig {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const payload = JSON.parse(raw);
  if (payload.schema_version !== 1) {
    throw new PolicyConfigurationError('Unsupported config schema_version');
  }
  validateThresholds(payload.thresholds);
  return payload as PolicyConfig;
}

export function loadBaseline(baselinePath: string): Record<string, number> {
  const raw = fs.readFileSync(baselinePath, 'utf-8');
  const payload = JSON.parse(raw);
  if (payload.schema_version !== 1) {
    throw new PolicyConfigurationError('Unsupported baseline schema_version');
  }
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(payload.files as Record<string, number>)) {
    if (typeof val !== 'number' || val < 0) {
      throw new PolicyConfigurationError(`Invalid line count for ${key}: ${val}`);
    }
    result[key] = val;
  }
  return result;
}

export function writeBaseline(
  baselineFilePath: string,
  reducedFiles: Record<string, number>,
  thresholds: Thresholds,
): void {
  const payload = {
    schema_version: 1,
    measurement: 'physical_lines_including_blanks_and_comments',
    thresholds,
    files: Object.fromEntries(Object.entries(reducedFiles).sort(([a], [b]) => a.localeCompare(b))),
  };
  const content = JSON.stringify(payload, null, 2) + '\n';
  const tmpPath = `${baselineFilePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, baselineFilePath);
}
