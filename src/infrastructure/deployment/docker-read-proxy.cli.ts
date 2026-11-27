import { createDockerReadProxy } from './docker-read-proxy.js';

const server = createDockerReadProxy('/var/run/docker.sock');
server.listen(23750, '127.0.0.1');
server.on('error', () => { console.error(JSON.stringify({ code: 'OWNERSHIP_PROXY_FAILED' })); process.exitCode = 1; });
const stop = () => { server.close(); server.closeAllConnections(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
