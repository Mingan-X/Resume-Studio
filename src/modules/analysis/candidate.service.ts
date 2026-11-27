import { parsedResumeSchema } from '../../contracts/parsed-resume.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import type { UsageReservation } from '../../contracts/tasks.js';
import { recallQuerySchema } from '../../contracts/recall.js';
import type { ExecutionClaim } from '../../infrastructure/consumer/contracts.js';
import type { CandidateRepository } from '../../infrastructure/jobs/candidate.repository.js';
import type { RecallService } from '../recall/recall.service.js';
import { redactContactText } from '../models/privacy.js';
import { requestHash } from '../tasks/request-hash.js';
import { TaskFailure } from '../../infrastructure/consumer/failure.js';

export function recallQueryFromResume(raw: unknown, corpusVersion: string) {
  const parsed = parsedResumeSchema.parse(raw);
  const skills = [...new Set(parsed.skills.map(item => redactContactText(item.name)).filter(value => value.trim() && !value.includes('█')))].slice(0, 100);
  const summary = redactContactText([
    skills.join('、'), ...parsed.work.flatMap(item => item.responsibilities),
    ...parsed.projects.flatMap(item => [item.description ?? '', item.technologies.join('、')]),
  ].join('\n')).slice(0, 20_000);
  return recallQuerySchema.parse({ schemaVersion: 1, corpusVersion, skills, summary, city: null });
}
export class AnalysisCandidateService {
  constructor(private readonly candidates: Pick<CandidateRepository, 'load' | 'freeze'>, private readonly recall: Pick<RecallService, 'recall'>) {}
  async freeze(claim: ExecutionClaim, rawResume: unknown, budget: { reserve: (usage: UsageReservation) => Promise<void> }, signal: AbortSignal) {
    const snapshot = realAnalysisInputSchema.parse(claim.snapshot), parsed = parsedResumeSchema.parse(rawResume);
    if (parsed.resumeVersionId !== snapshot.resumeVersionId) throw new TaskFailure('INPUT_INVALID');
    const query = recallQueryFromResume(parsed, snapshot.jobCorpusVersionId), previous = await this.candidates.load(claim.ownerId, claim.message.taskId);
    if (previous) {
      if (previous.content.recall.corpusHash !== snapshot.corpusHash || requestHash(previous.content.query) !== requestHash(query)
        || requestHash(previous.content.recall.config) !== requestHash(snapshot.recall)
        || requestHash(previous.content.recall.indexSpec) !== requestHash({ ...snapshot.indexTarget, ownerId: claim.ownerId })) throw new TaskFailure('INPUT_INVALID');
      // Revalidate the execution fence without recalling or changing the frozen members.
      return this.candidates.freeze(claim, previous.content.query, previous.content.recall);
    }
    const recalled = await this.recall.recall(query, snapshot.recall, { ...snapshot.indexTarget, ownerId: claim.ownerId },
      { signal, deadline: claim.deadline.getTime(), reserve: budget.reserve });
    signal.throwIfAborted();
    if (recalled.corpusHash !== snapshot.corpusHash) throw new TaskFailure('INPUT_INVALID');
    return this.candidates.freeze(claim, query, recalled);
  }
}
