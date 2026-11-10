import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as connectHttp2, type ClientHttp2Session } from 'node:http2';
import { connect as connectTls } from 'node:tls';

export const SPEECH_ORIGIN = 'https://aicode.googleapis.com';
export const SPEECH_RPC = '/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent';

export async function connectNativeSpeech(proxyUrl: string | undefined, signal: AbortSignal): Promise<ClientHttp2Session> {
  if (!proxyUrl) return connectHttp2(SPEECH_ORIGIN);
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Unsupported proxy protocol');
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: 'aicode.googleapis.com:443', signal,
      headers: {
        host: 'aicode.googleapis.com:443',
        ...(proxy.username || proxy.password ? { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {}),
      },
    });
    request.once('error', reject);
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) {
        socket.destroy();
        reject(new Error('Speech proxy tunnel failed'));
        return;
      }
      const secureSocket = connectTls({ socket, servername: 'aicode.googleapis.com', ALPNProtocols: ['h2'] });
      const abort = () => secureSocket.destroy(new Error('Speech connection aborted'));
      signal.addEventListener('abort', abort, { once: true });
      secureSocket.once('error', reject);
      secureSocket.once('secureConnect', () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) { secureSocket.destroy(); reject(new Error('Speech connection aborted')); return; }
        if (secureSocket.alpnProtocol !== 'h2') { secureSocket.destroy(); reject(new Error('Speech HTTP/2 unavailable')); return; }
        resolve(connectHttp2(SPEECH_ORIGIN, { createConnection: () => secureSocket }));
      });
    });
    request.end();
  });
}
