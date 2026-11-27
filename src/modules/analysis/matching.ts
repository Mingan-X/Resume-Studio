import { z } from 'zod';
import { jobRequirementSchema } from '../../contracts/jobs.js';
import { parsedResumeSchema } from '../../contracts/parsed-resume.js';
import { matchModelOutputSchema, storedJudgmentSchema } from '../../contracts/matching.js';
import type { ExtractedDocument } from '../../contracts/evidence.js';
import { validateEvidence } from '../resumes/evidence.js';
import { redactContactText } from '../models/privacy.js';
import { normalizeEmployment } from './dates.js';

export function judgeThreshold(jobVersionId: string, rawRequirement: unknown, rawResume: unknown, asOfDate: string) {
  const requirement = jobRequirementSchema.parse(rawRequirement), resume = parsedResumeSchema.parse(rawResume);
  if (!requirement.threshold) return null;
  const threshold = requirement.threshold;
  let verdict: 'met' | 'unmet' | 'unknown' = 'unknown', reason = '该阈值缺少可确定计算的指标或证据，不能由单位猜测业务含义';
  const evidenceRefs = resume.work.flatMap(work => work.sourceRefs);
  if (typeof threshold.value === 'number' && threshold.value >= 0 && ['employment_months', 'employment_years'].includes(threshold.unit)) {
    const months = normalizeEmployment(resume, asOfDate), target = threshold.value * (threshold.unit === 'employment_years' ? 12 : 1);
    if (evidenceRefs.length && Number.isFinite(target)) {
      if (threshold.operator === 'gte' && months.knownMonths >= target) verdict = 'met';
      else if (threshold.operator === 'lte' && months.knownMonths > target || threshold.operator === 'eq' && months.knownMonths > target) verdict = 'unmet';
      else if (months.incompleteIntervals === 0 && resume.work.length > 0) {
        verdict = (threshold.operator === 'gte' ? months.knownMonths >= target : threshold.operator === 'lte' ? months.knownMonths <= target : months.knownMonths === target) ? 'met' : 'unmet';
      }
      reason = verdict === 'unknown' ? '存在无法归一化的任职日期，已知月份不足以确定该阈值' : `按冻结日期和去重任职区间计算，已知月数为${months.knownMonths}`;
    }
  }
  return storedJudgmentSchema.parse({ jobVersionId, requirementId: requirement.stableId, verdict, reason,
    method: 'rule', evidenceRefs: verdict === 'unknown' ? [] : evidenceRefs });
}

export function validateMatchBatch(ownerId: string, document: ExtractedDocument, jobVersionId: string, rawIds: unknown, raw: unknown) {
  const expected = z.array(z.string()).min(1).max(10).parse(rawIds), output = matchModelOutputSchema.parse(raw);
  if (output.judgments.length !== expected.length || output.judgments.some(item => !expected.includes(item.requirementId))) throw new Error('MATCH_REQUIREMENT_MISMATCH');
  return output.judgments.map(judgment => {
    for (const ref of judgment.evidenceRefs) {
      validateEvidence(ownerId, ownerId, document, ref);
      const block = document.blocks.find(value => value.id === ref.blockId)!;
      if (redactContactText(block.text).slice(ref.start, ref.end) !== ref.quote || ref.quote.includes('█')) throw new Error('MATCH_EVIDENCE_INVALID');
    }
    return storedJudgmentSchema.parse({ ...judgment, jobVersionId, method: 'model' });
  });
}
