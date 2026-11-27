import { HttpException } from '@nestjs/common';
import type { INestApplication, HttpServer } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorResponseSchema } from '../../contracts/http.js';
import type { ApiConfig } from '../../modules/config/app-config.js';

export class RequestLimits {
  private readonly entries=new Map<string,{count:number;until:number}>();
  constructor(private readonly maximumKeys=10000){}
  take(key:string,limit:number,now=Date.now()):boolean{
    let value=this.entries.get(key);
    if(value&&value.until<=now){this.entries.delete(key);value=undefined;}
    if(!value){
      if(this.entries.size>=this.maximumKeys){for(const [candidate,bucket] of this.entries)if(bucket.until<=now)this.entries.delete(candidate);}
      if(this.entries.size>=this.maximumKeys)return false;
      value={count:0,until:now+60000};this.entries.set(key,value);
    }
    if(value.count>=limit)return false;value.count++;return true;
  }
  require(key:string,limit:number){if(!this.take(key,limit))throw new HttpException('Request limit',429);}
}

export function configureSecurity(app:INestApplication,config:ApiConfig):void{
  const limits=new RequestLimits();
  app.use((request:IncomingMessage,response:ServerResponse,next:()=>void)=>{
    response.setHeader('x-content-type-options','nosniff');response.setHeader('x-frame-options','DENY');
    response.setHeader('referrer-policy','no-referrer');response.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'");
    response.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
    if(config.APP_ENV==='production'&&config.auth)response.setHeader('strict-transport-security','max-age=31536000');
    const path=request.url?.split('?')[0]??'';
    if(path.startsWith('/api/'))response.setHeader('cache-control','no-store');
    if(config.auth&&path!=='/health'){
      // No trust in X-Forwarded-For; source is the directly connected peer. Reverse-proxy
      // traffic shares that source budget until a trusted proxy topology is configured.
      const source=request.socket.remoteAddress??'unknown';
      if(!limits.take(`source:${source}`,config.auth.sourceRequestsPerMinute)
        ||path.startsWith('/api/v1/auth/')&&!limits.take(`auth:${source}`,config.auth.authRequestsPerMinute)){
        response.statusCode=429;response.setHeader('content-type','application/json');response.setHeader('retry-after','60');
        response.end(JSON.stringify(errorResponseSchema.parse({code:'RATE_LIMITED',message:'请求过于频繁',retryable:true,requestId:response.getHeader('x-request-id')})));return;
      }
    }
    next();
  });
  const adapter:HttpServer=app.getHttpAdapter();if(adapter.getType()!=='express'||!adapter.useBodyParser)throw new Error('UNSUPPORTED_HTTP_ADAPTER');
  adapter.useBodyParser('json',false,{limit:1024*1024,strict:true,inflate:false});
  adapter.useBodyParser('urlencoded',false,{limit:1024*1024,extended:false,inflate:false,parameterLimit:20});
}
