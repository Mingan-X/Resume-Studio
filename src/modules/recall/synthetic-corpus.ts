import { z } from 'zod';
import { dimensionIds, jobVersionSchema } from '../../contracts/jobs.js';
import { jdDocument } from '../jobs/evidence.js';
import { requestHash } from '../tasks/request-hash.js';
import { normalizeSkills } from './skills.js';

export const syntheticCorpusVersion = 'synthetic-jd-zh-v1';
function stableUuid(value: unknown) {
  const hex = requestHash(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const roles = [
  { title: '前端工程师', skills: ['TypeScript', 'Vue.js', '自动化测试'] },
  { title: '交互开发工程师', skills: ['JavaScript', 'React', 'Git'] },
  { title: 'Node服务端工程师', skills: ['Node.js', 'Postgres', 'RabbitMQ'] },
  { title: 'Java服务端工程师', skills: ['Java', 'MySQL', 'Redis'] },
  { title: 'Python服务工程师', skills: ['Python', 'PostgreSQL', 'Docker'] },
  { title: 'Go平台工程师', skills: ['Golang', 'K8s', 'Redis'] },
  { title: '测试工程师', skills: ['自动化测试', 'Python', 'CI/CD'] },
  { title: '数据分析工程师', skills: ['数据分析', 'SQL', 'Python'] },
  { title: '算法工程师', skills: ['机器学习', 'Python', 'SQL'] },
  { title: '交付工程师', skills: ['Docker', 'Kubernetes', '持续交付'] },
];
const domains = ['订单管理', '库存管理', '预约服务', '内容检索', '物流模拟', '学习平台', '指标看板', '设备模拟', '文档管理', '工单平台'];

// This fixed version contains exactly 100 authored template combinations, no scraped or real JD.
export function generateSyntheticJobs(owner: string) {
  const ownerId = z.uuid().parse(owner);
  return roles.flatMap((role, roleIndex) => domains.map((domain, domainIndex) => {
    const sourceKey = `${roleIndex}-${domainIndex}`, id = stableUuid([ownerId, syntheticCorpusVersion, sourceKey, 'version']);
    const statements = [
      `能够使用${role.skills.join('、')}完成${domain}功能。`,
      `为${domain}核心流程编写自动化测试并参与代码评审。`,
      `说明${domain}需求的目标用户与约束，记录实现取舍。`,
      `记录${domain}改进前后的指标及个人负责范围。`,
      `与产品和测试协作处理${domain}问题并维护交付文档。`,
      `根据${domain}复盘反馈学习新方法并记录应用结果。`,
    ];
    const title = `合成${domain}${role.title}`, body = `【合成JD，仅用于开发验证，无真实招聘主体】\n${title}\n${statements.join('\n')}`;
    const document = jdDocument(id, body);
    return jobVersionSchema.parse({ schemaVersion: 1, id, ownerId,
      jobId: stableUuid([ownerId, syntheticCorpusVersion, sourceKey, 'job']), version: 1,
      title, city: ['北京', '上海', '深圳', '杭州', null][domainIndex % 5], level: null,
      skills: normalizeSkills(role.skills).skills, document,
      requirements: statements.map((quote, index) => ({ stableId: `requirement-${index + 1}`, dimension: dimensionIds[index],
        kind: 'SOFT', description: quote, threshold: null, weight: 1, priority: index,
        sourceRef: { sourceType: 'JD', sourceVersionId: id, blockId: document.blocks[0]!.id,
          start: body.indexOf(quote), end: body.indexOf(quote) + quote.length, quote } })),
      dimensionWeights: dimensionIds.map(dimension => ({ dimension, weight: 1 })),
      hardRequirementsConfirmed: false, weightsConfirmed: false, status: 'DRAFT', contentHash: null,
      publishedAt: null, indexStatus: 'NOT_REQUESTED', createdAt: '2026-11-27T00:00:00.000Z',
    });
  }));
}
