import { createServer, request } from 'node:http';
import { z } from 'zod';

const services = ['postgres', 'rabbitmq', 'qdrant', 'langfuse-web', 'langfuse-worker', 'langfuse-postgres', 'langfuse-redis', 'langfuse-clickhouse', 'langfuse-minio'];
const labelsSchema = z.record(z.string(), z.string());
const object = z.record(z.string(), z.unknown());
function owned(labels: Record<string, string>) {
  return labels['com.docker.compose.project'] === 'resume-studio' && services.includes(labels['com.docker.compose.service'] ?? '');
}
function volumeOwned(labels: Record<string, string>) {
  const project = labels['com.docker.compose.project'], volume = labels['com.docker.compose.volume'];
  return project === 'resume-studio' && ['postgres_data','rabbitmq_data','qdrant_data','langfuse_postgres_data','langfuse_redis_data',
    'langfuse_clickhouse_data','langfuse_clickhouse_logs','langfuse_minio_data'].includes(volume ?? '') ||
    project === 'resume-studio-observability' && ['postgres_data','redis_data','clickhouse_data','clickhouse_logs','minio_data'].includes(volume ?? '');
}
function select(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
}
async function dockerGet(socketPath: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const abort = AbortSignal.timeout(3000);
    const call = request({ socketPath, path, method: 'GET', signal: abort }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error('DOCKER_READ_FAILED')); return; }
      const parts: Buffer[] = []; let length = 0;
      response.on('data', (part: Buffer) => { length += part.length;
        if (length > 2 * 1024 * 1024) { response.destroy(); reject(new Error('DOCKER_READ_LIMIT')); } else parts.push(part); });
      response.on('error', reject);
      response.on('end', () => { try { const value: unknown = JSON.parse(Buffer.concat(parts).toString('utf8')); resolve(value); } catch { reject(new Error('DOCKER_JSON_INVALID')); } });
    }); call.on('error', reject); call.end();
  });
}

// Docker socket is held only here. Applications can read project ownership metadata,
// never exec/start/stop/delete or retrieve container environment, credentials or logs.
export function createDockerReadProxy(socketPath: string) {
  let active = 0;
  const server = createServer((req, res) => {
    if (!['GET','HEAD'].includes(req.method ?? '') || active >= 4) { res.writeHead(403).end(); return; }
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { res.writeHead(400).end(); return; }
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, '/');
    const allowed = path === '/_ping' || path === '/version' || path === '/containers/json' || /^\/containers\/[a-f0-9]{64}\/json$/.test(path) ||
      /^\/volumes\/[a-z0-9_-]{1,128}$/.test(path) || /^\/networks\/[a-z0-9_-]{1,128}$/.test(path);
    if (!allowed || req.method === 'HEAD' && path !== '/_ping') { res.writeHead(403).end(); return; }
    active++;
    void (async () => {
      try {
        let target = path === '/_ping' ? '/version' : path;
        if (path === '/containers/json') {
          const selectors = z.union([z.array(z.string().max(256)).max(10),
            z.record(z.string().max(256), z.boolean()).refine(value => Object.keys(value).length <= 10)
              .transform(value => Object.keys(value).filter(key => value[key]))]);
          const filters = z.record(z.string(), selectors).parse(JSON.parse(url.searchParams.get('filters') ?? '{}') as unknown);
          const requested = (filters.label ?? []).filter(item => !item.startsWith('com.docker.compose.project='));
          target += `?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [...requested, 'com.docker.compose.project=resume-studio'] }))}`;
        } else if (url.search) throw new Error('UNSUPPORTED_QUERY');
        const raw = await dockerGet(socketPath, target);
        if (path === '/_ping') {
          const version = z.object({ ApiVersion: z.string().regex(/^\d+\.\d+$/), Os: z.literal('linux') }).parse(raw);
          res.writeHead(200, { 'API-Version': version.ApiVersion, OSType: version.Os }).end('OK'); return;
        }
        let result: unknown;
        if (path === '/version') result = select(object.parse(raw), ['Version','ApiVersion','MinAPIVersion','Os','Arch']);
        else if (path === '/containers/json') result = z.array(object).parse(raw).filter(item => owned(labelsSchema.parse(item.Labels)))
          .map(item => select(item, ['Id','Names','Image','ImageID','Created','Ports','Labels','State','Status','NetworkSettings']));
        else if (path.startsWith('/containers/')) {
          const info = object.parse(raw), config = object.parse(info.Config), labels = labelsSchema.parse(config.Labels);
          if (!owned(labels)) throw new Error('FOREIGN_CONTAINER');
          const state = object.parse(info.State);
          result = { ...select(info, ['Id','Name','NetworkSettings','Mounts']), Config: { Labels: labels },
            State: { ...select(state, ['Running','Status','ExitCode','OOMKilled']),
              ...(state.Health ? { Health: select(object.parse(state.Health), ['Status']) } : {}) } };
        } else {
          const info = object.parse(raw), labels = labelsSchema.parse(info.Labels);
          if (path.startsWith('/volumes/')) { if (!volumeOwned(labels)) throw new Error('FOREIGN_VOLUME'); }
          else if (labels['com.docker.compose.project'] !== 'resume-studio' || !['default','observability'].includes(labels['com.docker.compose.network'] ?? '')) throw new Error('FOREIGN_NETWORK');
          result = select(info, ['Id','Name','Labels','Containers']);
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch { res.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"PROJECT_METADATA_UNAVAILABLE"}'); }
      finally { active--; }
    })();
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 20;
  return server;
}
