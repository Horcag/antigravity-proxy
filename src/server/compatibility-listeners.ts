import http from 'node:http';

/** Application ports expose inference APIs, keeping management and native CONNECT separate. */
export async function openCompatibilityListeners(
  primary: http.Server,
  ports: number[],
): Promise<http.Server[]> {
  const listeners: http.Server[] = [];
  try {
    for (const port of ports) {
      const listener = http.createServer((request, response) => {
        const path = (request.url ?? '/').split('?')[0];
        if (!/^\/(?:v1|v1beta)\//.test(path) || /(?:^|\/)\.\.?(?:\/|$)|%2e|%2f|%5c|\\/i.test(path)) {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Not found' } }));
          return;
        }
        primary.emit('request', request, response);
      });
      listener.on('connect', (_request, socket) => {
        socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
      });
      listener.on('upgrade', (_request, socket) => {
        socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n');
      });
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', () => {
          listener.off('error', reject);
          resolve();
        });
      });
      listeners.push(listener);
    }
    return listeners;
  } catch (error) {
    await closeCompatibilityListeners(listeners);
    throw error;
  }
}

export async function closeCompatibilityListeners(listeners: http.Server[]): Promise<void> {
  await Promise.all(listeners.map((listener) => new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
    listener.closeIdleConnections();
  })));
}
