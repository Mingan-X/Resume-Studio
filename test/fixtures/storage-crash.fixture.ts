import { Readable } from 'node:stream';
import { z } from 'zod';
import { LocalStorage } from '../../src/infrastructure/storage/local-storage.js';
const root = z.string().min(1).parse(process.env.STORAGE_TEST_ROOT);
const storage = await LocalStorage.create(root);
const file = await storage.stage(Readable.from([Buffer.from('synthetic crash upload')]));
await storage.commit(file);
process.send?.(file);
setInterval(() => {}, 1000);
