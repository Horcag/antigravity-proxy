#!/usr/bin/env node
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

    let activeBaseline = baseline;
    try {
      const reduced = buildReducedBaseline(discovered, baseline, config.thresholds);
      const isDifferent =
        Object.keys(reduced).length !== Object.keys(baseline).length ||
        Object.entries(reduced).some(([k, v]) => baseline[k] !== v);
      if (isDifferent) {
        writeBaseline(baselinePath, reduced, config.thresholds);
        activeBaseline = reduced;
      }
    } catch {
      // If there are regressions or new debt, evaluateFileSizes will report them below.
    }

    const result = evaluateFileSizes(discovered, activeBaseline, config.thresholds);

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

main();
