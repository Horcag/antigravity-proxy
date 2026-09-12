import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tsParser from '@typescript-eslint/parser';

const projectRoot = process.cwd();
const eslintConfigPath = path.join(projectRoot, 'eslint.config.mjs');
const sourceRoots = ['src', 'scripts'];
const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
]);

const sourceFilePattern = /\.(?:js|jsx|ts|tsx|mjs|cjs)$/u;

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

  if (!eslintConfig.includes('noInlineConfig: true')) {
    violations.push('eslint.config.mjs must enforce linterOptions.noInlineConfig: true');
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

export interface ExtractedComment {
  type: 'line' | 'block';
  text: string;
  line: number;
}

export function extractCommentsFromContent(content: string, filePath?: string): ExtractedComment[] {
  try {
    const ast = tsParser.parse(content, {
      comment: true,
      tokens: true,
      loc: true,
      range: true,
      jsx: true,
      filePath: filePath || 'temp.tsx',
    });

    return (ast.comments || []).map((c) => ({
      type: c.type === 'Line' ? 'line' : 'block',
      text: c.type === 'Line' ? `//${c.value}` : `/*${c.value}*/`,
      line: c.loc.start.line,
    }));
  } catch (cause: unknown) {
    throw new Error(`Debt audit could not parse ${filePath ?? '<input>'}`, { cause });
  }
}

export interface DebtViolation {
  file: string;
  line: number;
  type: 'unapproved-debt-disable' | 'missing-disable-reason' | 'blanket-disable-forbidden' | 'inline-config-forbidden' | 'unexplained-ts-directive';
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

      const content = fs.readFileSync(filePath, 'utf8');
      const comments = extractCommentsFromContent(content, relativePath);

      for (const comment of comments) {
        // 1. Forbid inline ESLint configuration comments (e.g. /* eslint "rule": "off" */ or /* eslint-env */)
        if (/\/\*\s*eslint\b(?!\s*-(?:disable|enable))/i.test(comment.text)) {
          violations.push({
            file: relativePath,
            line: comment.line,
            type: 'inline-config-forbidden',
            message: `${relativePath}:${comment.line} Inline ESLint rule configuration (/* eslint ... */) is forbidden. Configure rules in eslint.config.mjs.`,
          });
        }

        // 2. Check eslint-disable directives (handles single-line and multi-line comments)
        const disableMatch = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\s*([\s\S]*?)(?:\*\/|$)/u.exec(comment.text);
        if (disableMatch) {
          const rest = disableMatch[1].trim();
          if (!rest.includes('--')) {
            violations.push({
              file: relativePath,
              line: comment.line,
              type: 'missing-disable-reason',
              message: `${relativePath}:${comment.line} eslint-disable must specify rule names and an explanation (-- <reason>)`,
            });
          } else {
            const [rulesPart, ...reasonParts] = rest.split('--');
            const rules = rulesPart.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean);
            const reason = reasonParts.join('--').trim();

            // Blanket disable without rule names is forbidden
            if (rules.length === 0) {
              violations.push({
                file: relativePath,
                line: comment.line,
                type: 'blanket-disable-forbidden',
                message: `${relativePath}:${comment.line} Blanket eslint-disable without specific rule names is forbidden. Specific rules must be named before '-- <reason>'.`,
              });
            } else {
              for (const rule of rules) {
                if (!allowedInlineDebtDisableFiles.has(relativePath)) {
                  violations.push({
                    file: relativePath,
                    line: comment.line,
                    type: 'unapproved-debt-disable',
                    message: `${relativePath}:${comment.line} Rule disable (${rule}) is not in approved allowlist`,
                  });
                }
              }
            }

            if (!reason) {
              violations.push({
                file: relativePath,
                line: comment.line,
                type: 'missing-disable-reason',
                message: `${relativePath}:${comment.line} eslint-disable must include an explanation (-- <reason>)`,
              });
            }
          }
        }

        // 3. Check TypeScript suppression directives (@ts-ignore, @ts-expect-error, @ts-nocheck)
        if (/@ts-(?:ignore|expect-error|nocheck)\b/u.test(comment.text)) {
          const hasReason = /--\s*\S/u.test(comment.text);
          if (!hasReason) {
            violations.push({
              file: relativePath,
              line: comment.line,
              type: 'unexplained-ts-directive',
              message: `${relativePath}:${comment.line} TypeScript suppression directive must include an explanation (-- <reason>)`,
            });
          }
        }
      }
    }
  }

  return violations;
}

export function runDebtCheck(): number {
  try {
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
  } catch (err: unknown) {
    console.error('Code quality and architecture debt baseline check FAILED.');
    console.error((err as Error).message);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runDebtCheck());
}
