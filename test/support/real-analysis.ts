import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabaseService } from '../../src/infrastructure/database/database.service.js';
import { ResumeRepository } from '../../src/infrastructure/storage/resume.repository.js';
import { JobRepository } from '../../src/infrastructure/jobs/job.repository.js';
import { JobPublicationRepository } from '../../src/infrastructure/jobs/publication.repository.js';
import { JobCorpusRepository } from '../../src/infrastructure/jobs/corpus.repository.js';
import { AnalysisRepository } from '../../src/infrastructure/tasks/analysis.repository.js';
import { extractedDocument } from '../../src/modules/resumes/evidence.js';
import { rubricVersionSchema } from '../../src/contracts/rubric.js';
import { realAnalysisInputSchema, taskDispatchSchema } from '../../src/contracts/tasks.js';
import { skillDictionaryV1 } from '../../src/modules/recall/skills.js';
import { analysisConfiguration } from './analysis-inputs.js';
import { jobDraft } from './job-inputs.js';

export async function seedRealAnalysis(database: DatabaseService, ownerId: string,
  options: { settings?: ReturnType<typeof analysisConfiguration>; jobCount?: number; requirementCount?: number; allowSynthetic?: boolean } = {}) {
  const db = database.client, settings = options.settings ?? analysisConfiguration();
  settings.budget.maxTokens = Math.max(settings.budget.maxTokens, 500_000);
  await db.owner.create({ data: { id: ownerId } });
  const versionId = randomUUID(), fileHash = 'a'.repeat(64);
  const document = extractedDocument(versionId, fileHash, { parserVersion: 'test-parser-v1', warnings: [],
    blocks: [{ text: '合成简历：TypeScript工程实践。', location: { kind: 'PDF', page: 1, bounds: null } }] });
  await new ResumeRepository(database).register({ ownerId, idempotencyKey: randomUUID(), resumeId: randomUUID(), resumeVersionId: versionId,
    file: { id: randomUUID(), ownerId, storageKey: randomUUID(), sha256: fileHash, mime: 'application/pdf', size: 10, createdAt: new Date().toISOString() },
    blocks: document.blocks, document });
  const jobs = new JobRepository(database), publication = new JobPublicationRepository(database), drafts = [];
  for (let index = 0; index < (options.jobCount ?? 1); index++) {
    const draft = jobDraft(ownerId), template = draft.requirements[0]!;
    draft.requirements = Array.from({ length: options.requirementCount ?? 1 }, (_, index) => ({ ...template, stableId: `requirement-${String(index).padStart(3, '0')}` }));
    await jobs.createDraft(ownerId, draft); await publication.confirm(ownerId, draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
    await publication.publish(ownerId, draft.id, randomUUID(), { embeddingVersion: settings.embeddingVersion,
      indexVersion: settings.indexTarget.indexVersion, chunkerVersion: settings.indexTarget.chunkerVersion,
      componentVersion: settings.indexTarget.componentVersion, budget: settings.budget });
    drafts.push(draft);
  }
  await new JobCorpusRepository(database).freeze(ownerId, 'test-corpus-v1', drafts.map(draft => draft.id), skillDictionaryV1);
  await jobs.importRubric(ownerId, rubricVersionSchema.parse(JSON.parse(await readFile('resources/rubrics/rubric-v1.json', 'utf8')) as unknown));
  const taskId = await new AnalysisRepository(database).create(ownerId, randomUUID(), { resumeVersionId: versionId,
    asOfDate: '2026-11-27', jobCorpusVersionId: 'test-corpus-v1' }, settings, options.allowSynthetic);
  const task = await db.analysisTask.findUniqueOrThrow({ where: { id: taskId } });
  const event = await db.outboxEvent.findFirstOrThrow({ where: { ownerId, aggregateId: taskId } });
  return { taskId, message: taskDispatchSchema.parse(event.payload), snapshot: realAnalysisInputSchema.parse(task.inputSnapshot), document, draft: drafts[0]!, drafts, settings };
}

// Caller must verify the exact project instance and supply only its manifest-owned temporary owners.
export async function cleanRealAnalysis(database: DatabaseService, ownerId: string) {
  await database.client.$transaction(async tx => {
    await tx.nodeArtifact.deleteMany({ where: { ownerId } }); await tx.consumerReceipt.deleteMany({ where: { ownerId } });
    await tx.taskEvent.deleteMany({ where: { ownerId } }); await tx.taskAttempt.deleteMany({ where: { ownerId } });
    await tx.outboxEvent.deleteMany({ where: { ownerId } });

    await tx.profileAssessment.deleteMany({ where: { ownerId } }); await tx.matchPlan.deleteMany({ where: { ownerId } });
    await tx.candidateSet.deleteMany({ where: { ownerId } }); await tx.analysisTask.deleteMany({ where: { ownerId } });
    await tx.resumeExtraction.deleteMany({ where: { ownerId } });
    await tx.analysisConfiguration.deleteMany({ where: { ownerId } }); await tx.rubricVersion.deleteMany({ where: { ownerId } });
    await tx.jobCorpusVersion.deleteMany({ where: { ownerId } }); await tx.jobIndexTarget.deleteMany({ where: { ownerId } });
    await tx.jobIndexTask.deleteMany({ where: { ownerId } }); await tx.jobVersion.deleteMany({ where: { ownerId } }); await tx.job.deleteMany({ where: { ownerId } });
    await tx.resumeUpload.deleteMany({ where: { ownerId } }); await tx.extractedDocument.deleteMany({ where: { ownerId } });
    await tx.evidenceBlock.deleteMany({ where: { ownerId } }); await tx.resumeVersion.deleteMany({ where: { ownerId } });
    await tx.resume.deleteMany({ where: { ownerId } }); await tx.fileAsset.deleteMany({ where: { ownerId } }); await tx.owner.deleteMany({ where: { id: ownerId } });
  });
}
