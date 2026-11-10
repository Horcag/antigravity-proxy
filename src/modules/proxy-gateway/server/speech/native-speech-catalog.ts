import { buildUserAgent, FALLBACK_VERSION, resolveLocalInstalledVersion } from '../request-user-agent';
import { GoogleAPIService } from '@/modules/cloud-account/services/GoogleAPIService';

const CATALOG_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const MAX_CATALOG_BYTES = 1_000_000;

interface SpeechCatalogResponse { audioTranscriptionModelIds?: unknown }

export async function fetchNativeSpeechModels(
  accessToken: string,
  projectId?: string,
  proxyUrl?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  const response = await fetch(CATALOG_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': buildUserAgent(resolveLocalInstalledVersion() ?? FALLBACK_VERSION),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
    signal: requestSignal,
    ...GoogleAPIService.getFetchOptions(proxyUrl),
  } as RequestInit);
  if (!response.ok) throw new Error(`Native speech catalog request failed: HTTP ${response.status}`);

  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_CATALOG_BYTES) throw new Error('Native speech catalog response exceeded the size limit');
  if (!response.body) throw new Error('Native speech catalog response had no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CATALOG_BYTES) throw new Error('Native speech catalog response exceeded the size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const data = JSON.parse(new TextDecoder().decode(bytes)) as SpeechCatalogResponse;
  if (!Array.isArray(data.audioTranscriptionModelIds) || data.audioTranscriptionModelIds.some((id) => typeof id !== 'string')) {
    throw new Error('Native speech catalog response was invalid');
  }
  return [...new Set(data.audioTranscriptionModelIds as string[])];
}
