import {Inject,Injectable} from '@nestjs/common';
import {IDENTITY,ownerIdSchema} from '../identity/identity.module.js';
import type {IdentityPort} from '../identity/identity.module.js';
import {ReportRepository} from '../../infrastructure/tasks/report.repository.js';
@Injectable()
export class ReportService {
 constructor(@Inject(IDENTITY)private readonly identity:IdentityPort,private readonly reports:ReportRepository){}
 private async owner(){return ownerIdSchema.parse(await this.identity.getOwnerId());}
 async get(id:string){return this.reports.get(await this.owner(),id);}
 async list(query:unknown,sourceId?:string){return this.reports.list(await this.owner(),query,sourceId);}
}
