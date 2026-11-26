import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { once } from 'node:events';

// Real broker connection; forward the publish but hide its confirm, or drop the connection.
// Parse AMQP frames, since TCP chunks are not message boundaries.
export async function amqpFaultProxy(mode: 'timeout' | 'disconnect') {
  const sockets = new Set<Socket>();
  let published = false;
  const server = createServer(client => {
    const broker = connect(55672, '127.0.0.1');
    sockets.add(client); sockets.add(broker);
    for (const socket of [client, broker]) {
      socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(socket); client.destroy(); broker.destroy(); });
    }
    let header = true, buffer = Buffer.alloc(0);
    client.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (header) {
        if (buffer.length < 8) return;
        broker.write(buffer.subarray(0, 8)); buffer = buffer.subarray(8); header = false;
      }
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(3) + 8;
        if (buffer.length < size) break;
        const frame = buffer.subarray(0, size); buffer = buffer.subarray(size);
        if (frame[0] === 1 && size >= 12 && frame.readUInt16BE(7) === 60 && frame.readUInt16BE(9) === 40) {
          published = true;
          if (mode === 'disconnect') { client.destroy(); broker.destroy(); return; }
        }
        broker.write(frame);
      }
    });
    broker.on('data', data => { if (!published) client.write(data); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy address unavailable');
  return {
    port: address.port, sawPublish: () => published,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
