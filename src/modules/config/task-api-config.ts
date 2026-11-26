import { z } from 'zod';

// Development identity is deliberately restricted to the existing local project database.
export const taskApiConfigSchema = z.object({ databaseUrl: z.url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'postgresql:' && ['127.0.0.1','localhost'].includes(url.hostname)
      && url.port === '55432' && url.pathname === '/resume_studio_s12_test' && url.username === 'resume_studio_test'
      && url.password.length > 0 && !url.hash && !url.search;
  } catch { return false; }
}) }).strict().readonly();
