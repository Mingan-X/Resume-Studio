import { defineConfig } from 'prisma/config';
import { loadInfrastructureConfig } from './src/infrastructure/config.js';

// Even migrations must target the explicitly isolated diagnostic database.
const config = loadInfrastructureConfig(process.env);
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: config.databaseUrl },
});
