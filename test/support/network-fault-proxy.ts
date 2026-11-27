import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';

// A test-owned TCP boundary to an already ownership-verified project endpoint.
// No global firewall, service configuration or other process is changed.
export async function networkFaultProxy(port: 55432 | 56333 | 6333) {
  const sockets = new Set<Socket>(); let blocked = false;
  const server = createServer(client => {
    if (blocked) { client.destroy(); return; }
    const upstream = connect(port, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket); socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FAULT_PROXY_ADDRESS_INVALID');
  return { port: address.port, block() { blocked = true; for (const socket of sockets) socket.destroy(); },
    unblock() { blocked = false; }, async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}
