import * as fs from 'node:fs';
import * as path from 'node:path';

const projectRoot = process.cwd();
const eslintConfigPath = path.join(projectRoot, 'eslint.config.mjs');
const sourceRoots = ['src', 'scripts'];
const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.agent-work',
  '.git',
]);

const sourceFilePattern = /\.(?:js|jsx|ts|tsx|mjs|cjs)$/u;
const debtRulePattern = /\b(?:complexity|max-lines|max-params)\b/u;
const eslintDisablePattern = /(?:\/\/|\/\*|\*)\s*eslint-disable(?:-next-line|-line)?/u;
const tsDirectivePattern = /(?:\/\/|\/\*|\*)\s*@ts-(?:ignore|expect-error|nocheck)\b/u;
const disableReasonPattern = /--\s*\S/u;

// Excluded files (the validator itself)
const ignoredFiles = new Set<string>([
  'scripts/quality/check-debt-baseline.ts',
]);

// Legacy allowlist for inline debt rule disables (currently empty - 0 tech debt allowed)
const allowedInlineDebtDisableFiles = new Set<string>([]);

function checkEslintConfig(): string[] {
  const violations: string[] = [];
  if (!fs.existsSync(eslintConfigPath)) {
    violations.push('eslint.config.mjs not found');
    return violations;
  }

  const eslintConfig = fs.readFileSync(eslintConfigPath, 'utf8');
  const disabledDebtRulePattern = /(?:complexity|max-lines|max-params)['"]?:\s*['"]off/u;

  if (disabledDebtRulePattern.test(eslintConfig)) {
    violations.push('eslint.config.mjs contains globally disabled architecture debt rules (complexity, max-lines, max-params)');
  }

  return violations;
}

function listSourceFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...listSourceFiles(entryPath));
      }
      continue;
    }
    if (entry.isFile() && sourceFilePattern.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

export interface DebtViolation {
  file: string;
  line: number;
  type: 'unapproved-debt-disable' | 'missing-disable-reason' | 'unexplained-ts-directive';
  message: string;
}

export function findDebtViolations(): DebtViolation[] {
  const violations: DebtViolation[] = [];

  for (const sourceRoot of sourceRoots) {
    const rootPath = path.join(projectRoot, sourceRoot);
    if (!fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) {
      continue;
    }

    for (const filePath of listSourceFiles(rootPath)) {
      const relativePath = path.relative(projectRoot, filePath).replaceAll('\\', '/');
      if (ignoredFiles.has(relativePath)) {
        continue;
      }
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);

      lines.forEach((line, index) => {
        const lineNum = index + 1;

        // Check ESLint disable comments
        if (eslintDisablePattern.test(line)) {
          const hasReason = disableReasonPattern.test(line);

          // If disabling an architectural debt rule
          if (debtRulePattern.test(line)) {
            if (!allowedInlineDebtDisableFiles.has(relativePath)) {
              violations.push({
                file: relativePath,
                line: lineNum,
                type: 'unapproved-debt-disable',
                message: `${relativePath}:${lineNum} architecture debt disable is not in legacy allowlist`,
              });
              return;
            }
            if (!hasReason) {
              violations.push({
                file: relativePath,
                line: lineNum,
                type: 'missing-disable-reason',
                message: `${relativePath}:${lineNum} architecture debt disable requires a local reason (-- <reason>)`,
              });
              return;
            }
          }

          // General eslint-disable should have an explanation
          if (!hasReason) {
            violations.push({
              file: relativePath,
              line: lineNum,
              type: 'missing-disable-reason',
              message: `${relativePath}:${lineNum} eslint-disable must include an explanation (-- <reason>)`,
            });
          }
        }

        // Check TypeScript suppression directives (@ts-ignore, @ts-expect-error, @ts-nocheck)
        if (tsDirectivePattern.test(line)) {
          const hasReason = disableReasonPattern.test(line);
          if (!hasReason) {
            violations.push({
              file: relativePath,
              line: lineNum,
              type: 'unexplained-ts-directive',
              message: `${relativePath}:${lineNum} TypeScript suppression directive must include an explanation (-- <reason>)`,
            });
          }
        }
      });
    }
  }

  return violations;
}

export function runDebtCheck(): number {
  const configViolations = checkEslintConfig();
  const fileViolations = findDebtViolations();
  const allViolations = [...configViolations, ...fileViolations.map((v) => v.message)];

  if (allViolations.length > 0) {
    console.error('Code quality and architecture debt baseline check FAILED.');
    console.error('New or unexplained bypasses, suppresses, or rule disables are forbidden:');
    for (const violation of allViolations) {
      console.error(`- ${violation}`);
    }
    return 1;
  }

  console.log('Architecture debt baseline OK: 0 unapproved exception entries or unexplained suppressions.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runDebtCheck());
}
