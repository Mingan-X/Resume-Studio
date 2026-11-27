import type { IdentityPort } from '../identity/identity.module.js';
import { ownerIdSchema } from '../identity/identity.module.js';
import type { JobRepository } from '../../infrastructure/jobs/job.repository.js';
import type { JobCorpusRepository } from '../../infrastructure/jobs/corpus.repository.js';
import type { JobPublicationService } from '../jobs/job-publication.service.js';
import { requestHash } from '../tasks/request-hash.js';
import { generateSyntheticJobs, syntheticCorpusVersion } from './synthetic-corpus.js';
import { skillDictionaryV1 } from './skills.js';

export class CorpusImportService {
  constructor(private readonly identity: IdentityPort, private readonly jobs: JobRepository,
    private readonly publications: JobPublicationService, private readonly corpora: JobCorpusRepository) {}

  async importSynthetic() {
    const ownerId = ownerIdSchema.parse(await this.identity.getOwnerId()), drafts = generateSyntheticJobs(ownerId);
    for (const draft of drafts) {
      let current = await this.jobs.findVersion(ownerId, draft.id);
      if (!current) {
        try { current = await this.jobs.createDraft(ownerId, draft); }
        catch (error) {
          // Concurrent/restarted import: only accept an identical deterministic version.
          current = await this.jobs.findVersion(ownerId, draft.id);
          if (!current) throw error;
        }
      }
      const content = (value: typeof draft) => ({ jobId: value.jobId, id: value.id, version: value.version,
        title: value.title, city: value.city, level: value.level, skills: value.skills, document: value.document,
        requirements: value.requirements, dimensionWeights: value.dimensionWeights });
      if (requestHash(content(current)) !== requestHash(content(draft))) throw new Error('SYNTHETIC_CORPUS_CONTENT_CONFLICT');
      if (current.status === 'DRAFT') await this.publications.confirm(draft.id, { hardRequirementsConfirmed: true, weightsConfirmed: true });
      // Publication's transaction owns PUBLISHED + task + target + Outbox, including replay.
      await this.publications.publish(draft.id, draft.id);
    }
    return this.corpora.freeze(ownerId, syntheticCorpusVersion, drafts.map(draft => draft.id), skillDictionaryV1);
  }
}
