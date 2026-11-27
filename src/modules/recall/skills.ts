import { z } from 'zod';
import { skillDictionarySchema } from '../../contracts/job-corpus.js';

// Exact structured tokens only: substring guessing would confuse Java with JavaScript.
function key(value: string) { return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' '); }
export const skillDictionaryV1 = skillDictionarySchema.parse({ schemaVersion: 1, version: 'skills-zh-v1', entries: [
  { name: 'typescript', aliases: ['TypeScript', 'TS'] }, { name: 'javascript', aliases: ['JavaScript', 'JS'] },
  { name: 'node.js', aliases: ['NodeJS', 'Node.js', 'Node'] }, { name: 'java', aliases: ['Java'] },
  { name: 'python', aliases: ['Python', 'Python语言'] }, { name: 'go', aliases: ['Golang', 'Go语言'] },
  { name: 'vue', aliases: ['Vue.js', 'VueJS'] }, { name: 'react', aliases: ['React.js', 'ReactJS'] },
  { name: 'postgresql', aliases: ['Postgres', 'PostgreSQL'] }, { name: 'mysql', aliases: ['MySQL'] },
  { name: 'redis', aliases: ['Redis'] }, { name: 'docker', aliases: ['Docker', '容器化'] },
  { name: 'kubernetes', aliases: ['K8s', 'Kubernetes'] }, { name: 'rabbitmq', aliases: ['RabbitMQ'] },
  { name: 'sql', aliases: ['SQL', '结构化查询语言'] }, { name: 'git', aliases: ['Git', '版本控制'] },
  { name: 'testing', aliases: ['自动化测试', '软件测试'] }, { name: 'ci-cd', aliases: ['CI/CD', '持续集成', '持续交付'] },
  { name: 'data-analysis', aliases: ['数据分析', 'Data Analysis'] }, { name: 'machine-learning', aliases: ['机器学习', 'Machine Learning'] },
] });

export function normalizeSkills(raw: unknown, rawDictionary: unknown = skillDictionaryV1) {
  const input = z.array(z.string().trim().min(1).max(128)).max(100).parse(raw);
  const dictionary = skillDictionarySchema.parse(rawDictionary), aliases = new Map<string, string>();
  const names = new Set<string>();
  for (const entry of dictionary.entries) {
    if (entry.name !== key(entry.name) || names.has(entry.name)) throw new Error('INVALID_SKILL_DICTIONARY');
    names.add(entry.name);
    for (const alias of [entry.name, ...entry.aliases]) {
      const normalized = key(alias), prior = aliases.get(normalized);
      if (!normalized || (prior && prior !== entry.name)) throw new Error('AMBIGUOUS_SKILL_ALIAS');
      aliases.set(normalized, entry.name);
    }
  }
  const skills = [...new Set(input.map(item => aliases.get(key(item)) ?? key(item)))].sort();
  return { dictionaryVersion: dictionary.version, skills };
}
