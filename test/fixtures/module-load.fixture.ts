import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';

const target = process.env.MODULE_LOAD_REPORT;
if (!target) throw new Error('Module-load test report path is required.');
const loaded = new Set<string>();
registerHooks({
  load(url, context, nextLoad) {
    loaded.add(url);
    return nextLoad(url, context);
  },
});
process.once('exit', () => writeFileSync(target, JSON.stringify([...loaded])));
