import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ConfigManager } from '@/modules/config/ipc/manager';
import { ProxyApiProjectSchema, ProxyConfigSchema } from '@/modules/config/types';
import { CloudAccountRepo } from '@/modules/cloud-account/persistence/cloudHandler';
import { CloudAccountSchema, type CloudAccount } from '@/modules/cloud-account/types';

const migrationStatus = z.enum(['active', 'blocked', 'disabled']);
const credential = z.string().trim().min(1);
const antigravityAccount = z.object({
  type: z.literal('antigravity'),
  email: z.email(),
  name: z.string().optional(),
  access_token: credential,
  refresh_token: credential,
  project_id: credential,
  expired: z.iso.datetime({ offset: true }).optional(),
  timestamp: z.number().finite().nonnegative().optional(),
  expires_in: z.number().finite().nonnegative().optional(),
  migration_status: migrationStatus,
});
const payloadSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProxyApiProjectSchema),
  accounts: z.array(z.discriminatedUnion('type', [
    antigravityAccount,
    z.object({ type: z.literal('codex'), migration_status: migrationStatus }),
  ])),
  model_mapping: z.record(z.string().min(1), z.string().min(1)),
});

export interface EasyCliImportResult {
  projectsImported: number;
  projectsExisting: number;
  accountsImported: number;
  accountsUpdated: number;
  accountsSkipped: number;
  accountsActive: number;
  accountsBlocked: number;
  accountsDisabled: number;
  modelMappingsImported: number;
}

type AntigravityAccount = z.infer<typeof antigravityAccount>;

class MigrationPersistenceError extends Error {
  constructor(restored: boolean, phase: 'config' | 'accounts', rollbackFailures: number) {
    super(restored
      ? 'EasyCLI migration failed; previous state restored'
      : `EasyCLI partial migration; restore destination backup before retry (phase=${phase}, rollbackFailures=${rollbackFailures})`);
  }
}

function convertAccount(source: AntigravityAccount, existing?: CloudAccount): CloudAccount {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = source.expires_in ?? 3600;
  let quota = existing?.quota;
  if (source.migration_status === 'blocked') {
    quota = { ...quota, models: quota?.models ?? {}, is_forbidden: true, isForbidden: true };
  } else if (source.migration_status === 'active' && quota && (quota.is_forbidden || quota.isForbidden)) {
    quota = { ...quota, is_forbidden: false, isForbidden: false };
  }
  return CloudAccountSchema.parse({
    ...existing,
    id: existing?.id ?? randomUUID(),
    provider: 'google',
    email: source.email,
    name: existing?.name ?? source.name,
    created_at: existing?.created_at ?? now,
    last_used: existing?.last_used ?? 0,
    token: {
      ...existing?.token,
      access_token: source.access_token,
      refresh_token: source.refresh_token,
      project_id: source.project_id,
      email: source.email,
      token_type: 'Bearer',
      expires_in: expiresIn,
      expiry_timestamp: source.expired
        ? Math.floor(Date.parse(source.expired) / 1000)
        : Math.floor(source.timestamp ?? now) + expiresIn,
    },
    status: source.migration_status === 'active' ? 'active' : 'expired',
    status_reason: source.migration_status === 'blocked'
      ? 'TOS_VIOLATION'
      : source.migration_status === 'disabled' ? 'MIGRATION_DISABLED' : undefined,
    is_active: source.migration_status === 'active',
    quota,
  });
}

export async function importEasyCliPayload(input: unknown): Promise<EasyCliImportResult> {
  try {
    return await importValidatedPayload(input);
  } catch (error) {
    if (error instanceof MigrationPersistenceError) throw error;
    // Input, database errors and Zod diagnostics may contain credentials.
    throw new Error('EasyCLI migration failed; input or destination could not be validated or saved');
  }
}

async function importValidatedPayload(input: unknown): Promise<EasyCliImportResult> {
  const payload = payloadSchema.parse(input);
  const emails = new Set<string>();
  for (const account of payload.accounts) {
    if (account.type !== 'antigravity') continue;
    const email = account.email.toLowerCase();
    if (emails.has(email)) throw new Error('Duplicate migration account');
    emails.add(email);
  }
  // Validate source collisions before merging with destination identities.
  ProxyConfigSchema.parse({ projects: payload.projects });
  const config = ConfigManager.loadConfig();
  const projects = [...(config.proxy.projects ?? [])];
  let projectsImported = 0;
  for (const project of payload.projects) {
    const sameId = projects.find((entry) => entry.id === project.id);
    const sameKey = projects.find((entry) => entry.api_key === project.api_key);
    if (sameId && sameId.api_key !== project.api_key) throw new Error('Project identity conflict');
    if (sameKey) continue;
    projects.push(project);
    projectsImported += 1;
  }
  const proxy = ProxyConfigSchema.parse({
    ...config.proxy,
    projects,
    custom_mapping: { ...config.proxy.custom_mapping, ...payload.model_mapping },
  });
  const prepared: Array<{ account: CloudAccount; original?: CloudAccount; status: AntigravityAccount['migration_status'] }> = [];
  for (const source of payload.accounts) {
    if (source.type !== 'antigravity') continue;
    const existing = await CloudAccountRepo.getAccountByEmail(source.email);
    if (existing && existing.provider !== 'google') throw new Error('Account provider conflict');
    prepared.push({ account: convertAccount(source, existing), original: existing, status: source.migration_status });
  }
  // All payload, destination collisions and converted records are checked before writes.
  let phase: 'config' | 'accounts' = 'config';
  try {
    await ConfigManager.saveConfig({ proxy });
    phase = 'accounts';
    for (const { account } of prepared) await CloudAccountRepo.addAccount(account);
  } catch {
    let rollbackFailures = 0;
    // Writes may commit before throwing. Restore every prepared account, including
    // the failing write and not-yet-attempted rows, rather than trusting counters.
    for (const { account, original } of prepared) {
      try {
        if (original) await CloudAccountRepo.addAccount(original);
        else await CloudAccountRepo.removeAccount(account.id);
      } catch {
        rollbackFailures += 1;
      }
    }
    try {
      // Explicit undefined removes the newly added optional projects property when
      // saveConfig merges with the current file before serializing it.
      await ConfigManager.saveConfig({ proxy: { ...config.proxy, projects: config.proxy.projects } });
    } catch {
      rollbackFailures += 1;
    }
    // Compensation handles observed process errors, not interruption/crash atomicity.
    // The offline operator must retain a destination DB/config backup before import.
    throw new MigrationPersistenceError(rollbackFailures === 0, phase, rollbackFailures);
  }
  return {
    projectsImported,
    projectsExisting: payload.projects.length - projectsImported,
    accountsImported: prepared.filter((entry) => !entry.original).length,
    accountsUpdated: prepared.filter((entry) => entry.original).length,
    accountsSkipped: payload.accounts.length - prepared.length,
    accountsActive: prepared.filter((entry) => entry.status === 'active').length,
    accountsBlocked: prepared.filter((entry) => entry.status === 'blocked').length,
    accountsDisabled: prepared.filter((entry) => entry.status === 'disabled').length,
    modelMappingsImported: Object.keys(payload.model_mapping).length,
  };
}
