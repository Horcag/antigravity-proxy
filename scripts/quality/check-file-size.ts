#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import {
  discoverSourceFiles,
  evaluateFileSizes,
  loadBaseline,
  loadConfig,
  buildReducedBaseline,
  writeBaseline,
  EXIT_OK,
  EXIT_CONFIGURATION_ERROR,
  PolicyResult,
  Thresholds,
  BaselineUpdateError,
  PolicyConfigurationError,
} from './file-size-policy.js';

function formatTextReport(result: PolicyResult, scannedCount: number): string {
  const lines: string[] = [];
  for (const f of result.findings) {
    const baseInfo = f.baseline_lines !== undefined ? `, baseline=${f.baseline_lines}` : '';
    const blockMark = f.blocking ? 'BLOCK' : 'INFO';
    lines.push(`[${f.severity.toUpperCase()}][${blockMark}] ${f.path}: ${f.lines} lines${baseInfo} - ${f.message}`);
  }
  const summary = result.summary(scannedCount);
  lines.push(
    `File-size policy: scanned=${summary.scanned_files}, findings=${summary.findings}, warnings=${summary.warnings}, errors=${summary.errors}, critical=${summary.critical}, blocking=${summary.blocking}, exit=${result.exit_code}`,
  );
  return lines.join('\n');
}

function formatJsonReport(result: PolicyResult, scannedCount: number, thresholds: Thresholds): string {
  const payload = {
    schema_version: 1,
    measurement: 'physical_lines_including_blanks_and_comments',
    thresholds,
    summary: result.summary(scannedCount),
    findings: result.findings,
    exit_code: result.exit_code,
  };
  return JSON.stringify(payload, null, 2);
}

function getGitFileContent(repoRoot: string, gitRef: string, filePath: string): string | null {
  try {
    return execFileSync('git', ['show', `${gitRef}:${filePath}`], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function verifyBaselineIntegrity(
  repoRoot: string,
  candidateBaseline: Record<string, number>,
  baselineRelPath: string,
  options?: { trustedRef?: string; trustedBaselineJson?: string },
): void {
  const gitPath = baselineRelPath.replaceAll('\\', '/');

  let trustedJson: string | null = options?.trustedBaselineJson ?? null;
  let resolvedRef: string | null = options?.trustedRef ?? null;

  if (!trustedJson) {
    const explicitRef = options?.trustedRef || process.env.QUALITY_TRUSTED_REF;
    if (explicitRef) {
      trustedJson = getGitFileContent(repoRoot, explicitRef, gitPath);
      if (!trustedJson) {
        throw new PolicyConfigurationError(
          `Explicit trusted reference [${explicitRef}] is not accessible or does not contain baseline file: ${gitPath}`,
        );
      }
      resolvedRef = explicitRef;
    } else {
      const defaultRefs = [
        process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null,
        'HEAD',
        'origin/main',
        'main',
      ].filter(Boolean) as string[];

      for (const ref of defaultRefs) {
        trustedJson = getGitFileContent(repoRoot, ref, gitPath);
        if (trustedJson) {
          resolvedRef = ref;
          break;
        }
      }
    }
  }

  // Fail-closed: Never fall back or allow unverified execution if trusted reference cannot be loaded
  if (!trustedJson) {
    throw new PolicyConfigurationError(
      'Cannot verify baseline integrity: no valid trusted upstream git reference found. Please set QUALITY_TRUSTED_REF or ensure upstream history is available.',
    );
  }

  let trustedBaseline: Record<string, number>;
  try {
    const parsed = JSON.parse(trustedJson);
    trustedBaseline = (parsed.files || {}) as Record<string, number>;
  } catch (err: any) {
    throw new PolicyConfigurationError(
      `Failed to parse trusted baseline from git reference [${resolvedRef || 'unknown'}]: ${err?.message || err}`,
    );
  }

  // 1. Forbid adding any new unbaselined files to baseline
  for (const key of Object.keys(candidateBaseline)) {
    if (trustedBaseline[key] === undefined) {
      throw new PolicyConfigurationError(
        `Baseline tampering detected: Cannot add new oversized file to baseline: ${key}. New files must be <= 500 lines (trusted ref: ${resolvedRef}).`,
      );
    }
  }

  // 2. Forbid manually increasing the cap
  for (const [key, candidateLines] of Object.entries(candidateBaseline)) {
    const trustedLines = trustedBaseline[key];
    if (trustedLines !== undefined && candidateLines > trustedLines) {
      throw new PolicyConfigurationError(
        `Baseline tampering detected: Baseline limit for ${key} cannot be manually increased from ${trustedLines} to ${candidateLines}. Baseline can only ratchet down (trusted ref: ${resolvedRef}).`,
      );
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let repoRoot = process.cwd();
  let configRel = 'quality/file-size-policy.json';
  let format: 'text' | 'json' = 'text';
  let updateBaseline = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      repoRoot = path.resolve(args[++i]);
    } else if (args[i] === '--config' && i + 1 < args.length) {
      configRel = args[++i];
    } else if (args[i] === '--format' && i + 1 < args.length) {
      const val = args[++i];
      if (val === 'json' || val === 'text') format = val;
    } else if (args[i] === '--update-baseline') {
      updateBaseline = true;
    } else if (args[i] === '-h' || args[i] === '--help') {
      console.log('Usage: check-file-size [--root <path>] [--config <path>] [--format text|json] [--update-baseline]');
      process.exit(0);
    }
  }

  try {
    const configPath = path.resolve(repoRoot, configRel);
    const config = loadConfig(configPath);
    const baselinePath = path.resolve(repoRoot, config.baseline_path);
    const baseline = loadBaseline(baselinePath);

    // Verify baseline integrity against trusted git reference to prevent manual inflation
    verifyBaselineIntegrity(repoRoot, baseline, config.baseline_path);

    const discovered = discoverSourceFiles(repoRoot, config);

    if (updateBaseline) {
      try {
        const reduced = buildReducedBaseline(discovered, baseline, config.thresholds);
        writeBaseline(baselinePath, reduced, config.thresholds);
        console.log(`Successfully ratcheted baseline down to ${Object.keys(reduced).length} tracked legacy files.`);
        process.exit(EXIT_OK);
      } catch (err) {
        if (err instanceof BaselineUpdateError) {
          console.error(`ERROR: ${err.message}`);
          process.exit(err.exitCode);
        }
        throw err;
      }
    }

    // Normal check is STRICTLY READ-ONLY: never mutate baseline on disk during check
    const result = evaluateFileSizes(discovered, baseline, config.thresholds);

    if (format === 'json') {
      console.log(formatJsonReport(result, Object.keys(discovered).length, config.thresholds));
    } else {
      console.log(formatTextReport(result, Object.keys(discovered).length));
    }

    process.exit(result.exit_code);
  } catch (err: any) {
    if (err instanceof PolicyConfigurationError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(EXIT_CONFIGURATION_ERROR);
    }
    console.error(`Unexpected error: ${err?.stack || err}`);
    process.exit(EXIT_CONFIGURATION_ERROR);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
