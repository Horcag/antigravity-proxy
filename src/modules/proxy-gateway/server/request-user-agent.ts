import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { isString } from 'lodash-es';
import { logger } from '../../../shared/logging/logger';

const REMOTE_VERSION_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app';
const CHANGELOG_URL = 'https://antigravity.google/changelog';
export const FALLBACK_VERSION = '2.33.0';
const DEFAULT_REMOTE_TIMEOUT_MS = 2500;
const SERVER_VERSION_CACHE_TTL_MS = 300_000;
const VERSION_REGEX = /\d+\.\d+\.\d+/g;
const SEMVER_EXACT_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HUB_UA_VERSION_REGEX = /antigravity\/hub\/((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))/i;

type UserAgentSource = 'local' | 'remote' | 'changelog' | 'fallback';

interface UserAgentResolution {
  source: UserAgentSource;
  userAgent: string;
  version: string;
}

let cachedUserAgentResolution: UserAgentResolution | null = null;
let pendingUserAgentResolution: Promise<UserAgentResolution> | null = null;
let observedHubVersion: string | null = null;
let installedServerVersionCache: { value: string | null; checkedAt: number } | null = null;

function normalizeNonEmptyString(value: string | null | undefined): string | null {
  if (!isString(value)) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

function getPlatformTag(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'darwin';
    default:
      return 'linux';
  }
}

function getArchTag(): string {
  if (process.arch === 'x64') {
    return 'amd64';
  }

  if (process.arch === 'arm64') {
    return 'arm64';
  }

  return process.arch;
}

export function buildUserAgent(version: string): string {
  return `antigravity/hub/${version} (aidev_client; os_type=${getPlatformTag()}; arch=${getArchTag()})`;
}

function compareSemverVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10));
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;

    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function extractHighestSemver(text: string): string | null {
  const matches = text.match(VERSION_REGEX);
  if (!matches || matches.length === 0) {
    return null;
  }

  let best = matches[0];
  for (const candidate of matches) {
    if (compareSemverVersions(candidate, best) > 0) {
      best = candidate;
    }
  }

  return best;
}

function shouldSkipRemoteVersionLookup(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

export function resolveLocalInstalledVersion(): string | null {
  const configuredVersion = normalizeNonEmptyString(process.env.AG_PROXY_UPSTREAM_VERSION);
  if (!configuredVersion) {
    return null;
  }
  if (!SEMVER_EXACT_REGEX.test(configuredVersion)) {
    throw new Error('AG_PROXY_UPSTREAM_VERSION must be an exact major.minor.patch version');
  }
  return configuredVersion;
}

export function observeClientUserAgent(rawHeader: string | string[] | undefined): void {
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!isString(header) || !header.trim()) {
    return;
  }
  const match = HUB_UA_VERSION_REGEX.exec(header);
  if (!match) {
    return;
  }
  const version = match[1];
  if (!observedHubVersion || compareSemverVersions(version, observedHubVersion) > 0) {
    observedHubVersion = version;
    cachedUserAgentResolution = null;
  }
}

export function resetObservedClientUserAgentForTesting(): void {
  observedHubVersion = null;
  installedServerVersionCache = null;
}

function resolveInstalledAntigravityServerVersion(): string | null {
  if (shouldSkipRemoteVersionLookup()) {
    return null;
  }
  const now = Date.now();
  if (installedServerVersionCache && now - installedServerVersionCache.checkedAt < SERVER_VERSION_CACHE_TTL_MS) {
    return installedServerVersionCache.value;
  }
  let best: string | null = null;
  try {
    const serverBinDir = path.join(os.homedir(), '.antigravity-server', 'bin');
    for (const entry of fs.readdirSync(serverBinDir)) {
      if (!SEMVER_EXACT_REGEX.test(entry)) {
        continue;
      }
      if (!best || compareSemverVersions(entry, best) > 0) {
        best = entry;
      }
    }
  } catch {
    best = null;
  }
  installedServerVersionCache = { value: best, checkedAt: now };
  return best;
}

export function resolveEffectiveUpstreamVersion(): string {
  const localPin = resolveLocalInstalledVersion();
  if (localPin) {
    return localPin;
  }
  let best = FALLBACK_VERSION;
  if (observedHubVersion && compareSemverVersions(observedHubVersion, best) > 0) {
    best = observedHubVersion;
  }
  const installed = resolveInstalledAntigravityServerVersion();
  if (installed && compareSemverVersions(installed, best) > 0) {
    best = installed;
  }
  return best;
}

async function fetchTextPayload(url: string): Promise<string | null> {
  try {
    const discoveryVersion = resolveEffectiveUpstreamVersion();
    const response = await axios.get<string>(url, {
      timeout: DEFAULT_REMOTE_TIMEOUT_MS,
      responseType: 'text',
      headers: {
        'User-Agent': buildUserAgent(discoveryVersion),
      },
    });

    if (isString(response.data)) {
      return response.data;
    }

    return JSON.stringify(response.data);
  } catch {
    return null;
  }
}

async function resolveRemoteVersion(): Promise<{
  source: Extract<UserAgentSource, 'remote' | 'changelog'>;
  version: string;
} | null> {
  if (shouldSkipRemoteVersionLookup()) {
    return null;
  }

  const remotePayload = await fetchTextPayload(REMOTE_VERSION_URL);
  if (remotePayload) {
    const parsed = extractHighestSemver(remotePayload);
    if (parsed) {
      return {
        source: 'remote',
        version: parsed,
      };
    }
  }

  const changelogPayload = await fetchTextPayload(CHANGELOG_URL);
  if (!changelogPayload) {
    return null;
  }

  const parsed = extractHighestSemver(changelogPayload);
  if (!parsed) {
    return null;
  }

  return {
    source: 'changelog',
    version: parsed,
  };
}

async function resolveDefaultUserAgentResolution(): Promise<UserAgentResolution> {
  const localVersion = resolveLocalInstalledVersion();
  if (localVersion) {
    return {
      source: 'local',
      version: localVersion,
      userAgent: buildUserAgent(localVersion),
    };
  }

  let bestVersion = resolveEffectiveUpstreamVersion();
  let bestSource: UserAgentSource = 'fallback';

  const remoteVersion = await resolveRemoteVersion();
  if (remoteVersion && compareSemverVersions(remoteVersion.version, bestVersion) > 0) {
    bestVersion = remoteVersion.version;
    bestSource = remoteVersion.source;
  }

  return {
    source: bestSource,
    version: bestVersion,
    userAgent: buildUserAgent(bestVersion),
  };
}

async function getResolvedDefaultRequestUserAgent(): Promise<string> {
  if (cachedUserAgentResolution) {
    return cachedUserAgentResolution.userAgent;
  }

  if (pendingUserAgentResolution) {
    return (await pendingUserAgentResolution).userAgent;
  }

  pendingUserAgentResolution = resolveDefaultUserAgentResolution()
    .then((resolved) => {
      cachedUserAgentResolution = resolved;
      logger.info(
        `Default request User-Agent resolved (source=${resolved.source}, version=${resolved.version}): ${resolved.userAgent}`,
      );
      return resolved;
    })
    .finally(() => {
      pendingUserAgentResolution = null;
    });

  return (await pendingUserAgentResolution).userAgent;
}

export async function resolveRequestUserAgent(): Promise<string> {
  return await getResolvedDefaultRequestUserAgent();
}
