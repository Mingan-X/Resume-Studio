import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ExecutionClaim } from '../consumer/contracts.js';
import { realAnalysisInputSchema } from '../../contracts/tasks.js';
import { analysisSummarySchema } from '../../contracts/analysis-summary.js';
import { reportContentSchema, reportInputSchema, reportResponseSchema, reportSummarySchema } from '../../contracts/reports.js';
import type { ReportContent } from '../../contracts/reports.js';
import { extractedDocumentSchema } from '../../contracts/evidence.js';
import { validateParsedResume } from '../../modules/resumes/parsed-resume.js';
import { profileAssessmentSchema } from '../../contracts/profile.js';
import { candidateSetContentSchema } from '../../contracts/candidates.js';
import { matchPlanSchema, requirementExecutionSchema } from '../../contracts/matching.js';
import { jobVersionResponseSchema } from '../../contracts/job-api.js';
import { rankingResultSchema } from '../../contracts/scoring.js';
import { requestHash } from '../../modules/tasks/request-hash.js';

export function reportResponse(row:{id:string;taskId:string;revision:number;rootReportId:string;sourceReportId:string|null;createdAt:Date;content:unknown;contentHash:string}) {
  const content=reportContentSchema.parse(row.content); if(requestHash(content)!==row.contentHash)throw new Error('REPORT_HASH_INVALID');
  return reportResponseSchema.parse({id:row.id,taskId:row.taskId,revision:row.revision,rootReportId:row.rootReportId,sourceReportId:row.sourceReportId,createdAt:row.createdAt.toISOString(),content});
}
export function reportSummary(row:Parameters<typeof reportResponse>[0]) {
  const {content,...metadata}=reportResponse(row);
  return reportSummarySchema.parse({...metadata,status:content.status,resumeVersionId:content.input.resumeVersionId,topCount:content.ranking?.top10.length??0,warnings:content.warnings});
}
export async function insertFinalReport(tx:Prisma.TransactionClient,claim:ExecutionClaim,rawSummary:unknown) {
  const input=realAnalysisInputSchema.parse(claim.snapshot), summary=analysisSummarySchema.parse(rawSummary);
  if(summary.status==='FAILED')return null;
  const operationKey=requestHash({ownerId:claim.ownerId,taskId:claim.message.taskId,reportVersion:1});
  const prior=await tx.analysisReport.findUnique({where:{operationKey}});
  if(prior){if(prior.ownerId!==claim.ownerId||prior.taskId!==claim.message.taskId)throw new Error('REPORT_IDENTITY_INVALID');reportResponse(prior);return prior.id;}
  const documentRow=await tx.extractedDocument.findFirst({where:{ownerId:claim.ownerId,sourceVersionId:input.resumeVersionId}});
  const extraction=await tx.resumeExtraction.findFirst({where:{ownerId:claim.ownerId,resumeVersionId:input.resumeVersionId,promptVersion:input.promptVersion,modelConfigVersion:input.modelConfigVersion,schemaVersion:1}});
  if(!documentRow||!extraction)throw new Error('REPORT_RESUME_MISSING');
  const document=extractedDocumentSchema.parse(documentRow.document),parsed=validateParsedResume(claim.ownerId,input.ownerId,document,extraction.content);
  if(document.fileHash!==input.resumeFileHash||requestHash(parsed)!==extraction.contentHash)throw new Error('REPORT_RESUME_INVALID');
  const profileRow=summary.profileId?await tx.profileAssessment.findFirst({where:{ownerId:claim.ownerId,taskId:claim.message.taskId,id:summary.profileId}}):null;
  const profile=profileRow?profileAssessmentSchema.parse(profileRow.content):null;
  if(summary.profileId&&!profileRow||profileRow&&requestHash(profile)!==profileRow.contentHash)throw new Error('REPORT_PROFILE_INVALID');
  const candidateRow=summary.candidateSetId?await tx.candidateSet.findFirst({where:{ownerId:claim.ownerId,taskId:claim.message.taskId,id:summary.candidateSetId}}):null;
  const candidates=candidateRow?candidateSetContentSchema.parse(candidateRow.content):null;
  if(summary.candidateSetId&&!candidateRow||candidateRow&&requestHash(candidates)!==candidateRow.contentHash)throw new Error('REPORT_CANDIDATES_INVALID');
  const planRow=summary.matchPlanId?await tx.matchPlan.findFirst({where:{ownerId:claim.ownerId,taskId:claim.message.taskId,id:summary.matchPlanId},include:{executions:{orderBy:{ordinal:'asc'}}}}):null;
  const plan=planRow?matchPlanSchema.parse(planRow.content):null;
  if(summary.matchPlanId&&!planRow||planRow&&requestHash(plan)!==planRow.contentHash)throw new Error('REPORT_PLAN_INVALID');
  const executions=planRow?.executions.map(row=>requirementExecutionSchema.parse({jobVersionId:row.jobVersionId,requirementId:row.requirementId,ordinal:row.ordinal,status:row.status,judgment:row.judgment,errorCode:row.errorCode}))??[];
  const jobs=plan?.jobs.map(job=>{const {ownerId:_owner,...rest}=job;void _owner;return jobVersionResponseSchema.parse(rest);})??[];
  if(summary.rankingId&&!summary.scoreSetId)throw new Error('REPORT_SCORE_SET_MISSING');
  const ranked=summary.rankingId&&summary.scoreSetId?await tx.rankingSnapshot.findFirst({where:{ownerId:claim.ownerId,id:summary.rankingId,scoreSetId:summary.scoreSetId}}):null;
  const ranking=ranked?rankingResultSchema.parse(ranked.content):null;
  if(summary.rankingId&&!ranked||ranked&&requestHash(ranking)!==ranked.contentHash)throw new Error('REPORT_RANKING_INVALID');
  const planned=candidates?.recall.candidates.length??0,completed=plan?jobs.filter(job=>executions.filter(item=>item.jobVersionId===job.id).every(item=>item.status==='DONE')).length:0;
  const warnings:ReportContent['warnings']=[];
  if(!profile)warnings.push('PROFILE_UNAVAILABLE');if(!plan)warnings.push('MATCHING_UNAVAILABLE');
  if(candidates?.recall.degraded)warnings.push('DEGRADED_RECALL');if(summary.failed+summary.truncated+summary.pending)warnings.push('INCOMPLETE_REQUIREMENTS');
  if(candidates&&!planned)warnings.push('EMPTY_CANDIDATES');
  const content=reportContentSchema.parse({schemaVersion:1,taskId:claim.message.taskId,input:reportInputSchema.parse({resumeVersionId:input.resumeVersionId,asOfDate:input.asOfDate,
    jobCorpusVersionId:input.jobCorpusVersionId,rubricVersion:input.rubricVersion,scoringVersion:input.scoringVersion,promptVersion:input.promptVersion,modelConfigVersion:input.modelConfigVersion,embeddingVersion:input.embeddingVersion}),
    status:summary.status,extractedDocument:document,parsedResume:parsed,extractionId:extraction.id,profile,
    candidates:candidateRow&&candidates?{id:candidateRow.id,contentHash:candidateRow.contentHash,ordered:candidates.recall.candidates,degraded:candidates.recall.degraded,degradationReason:candidates.recall.degradationReason}:null,
    jobs,executions,scoreSetId:summary.scoreSetId??null,ranking,candidateCoverage:{planned,completed,incomplete:planned-completed},
    requirementCoverage:{planned:summary.planned,completed:summary.completed,failed:summary.failed,truncated:summary.truncated,pending:summary.pending},warnings,
    sectionErrors:{profile:summary.profileError,matching:summary.matchingError}});
  const id=randomUUID();await tx.analysisReport.create({data:{id,ownerId:claim.ownerId,taskId:claim.message.taskId,revision:1,rootReportId:id,sourceReportId:null,
    operationKey,inputSnapshot:input,content,contentHash:requestHash(content)}});return id;
}
