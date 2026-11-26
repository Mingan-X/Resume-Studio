import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

// Defense in depth for trusted parser dependencies; not an arbitrary-code sandbox.
// Filesystem/child process/addon/worker restrictions are enforced by Node permissions.
export function restrictParserNetwork(): void {
  const denied = () => { throw new Error('PARSER_NETWORK_DENIED'); };
  for (const [object, names] of [
    [net, ['connect', 'createConnection', 'createServer']], [net.Socket.prototype, ['connect']],
    [http, ['request', 'get', 'createServer']], [https, ['request', 'get', 'createServer']],
    [tls, ['connect', 'createServer']], [dgram, ['createSocket']], [dns, ['lookup', 'resolve']],
  ] as const) for (const name of names) Object.defineProperty(object, name, { value: denied, writable: false });
  for (const name of ['fetch', 'WebSocket']) Object.defineProperty(globalThis, name, { value: denied, writable: false });
  syncBuiltinESMExports();
}
