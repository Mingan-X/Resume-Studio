import {channel} from 'node:diagnostics_channel';
import {Socket} from 'node:net';
import {z} from 'zod';

const socketCode=z.enum(['ETIMEDOUT','ECONNREFUSED','ECONNRESET','EPIPE','ERR_SOCKET_CLOSED','UNKNOWN']);
export const socketDiagnosticSchema=z.object({
  id:z.int().positive(),elapsedMs:z.int().nonnegative(),connected:z.boolean(),bytesRead:z.int().nonnegative(),bytesWritten:z.int().nonnegative(),
  code:socketCode.optional(),syscall:z.enum(['connect','read','write','unknown']).optional(),errno:z.int().optional(),
  attemptTimeout:z.boolean(),ended:z.boolean(),
}).strict();
export function captureSocketDiagnostics(){
  const sockets=new Map<Socket,{id:number;start:number;connected:boolean;attemptTimeout:boolean;ended:boolean;error?:unknown}>();
  const observe=(input:unknown)=>{
    const parsed=z.object({socket:z.instanceof(Socket)}).safeParse(input);if(!parsed.success||sockets.size>=32)return;
    const socket=parsed.data.socket,record={id:sockets.size+1,start:performance.now(),connected:false,attemptTimeout:false,ended:false,error:undefined as unknown};
    sockets.set(socket,record);socket.once('connect',()=>{record.connected=true;});
    socket.on('connectionAttemptTimeout',()=>{record.attemptTimeout=true;});
    socket.once('error',error=>{record.error=error;});socket.once('close',()=>{record.ended=true;});
  };
  const diagnostics=channel('net.client.socket');diagnostics.subscribe(observe);
  return {close:()=>diagnostics.unsubscribe(observe),snapshot:()=>[...sockets].map(([socket,record])=>{
    const error=z.object({code:z.string().optional(),syscall:z.string().optional(),errno:z.number().optional()}).safeParse(record.error);
    return socketDiagnosticSchema.parse({id:record.id,elapsedMs:Math.round(performance.now()-record.start),connected:record.connected,
      bytesRead:socket.bytesRead,bytesWritten:socket.bytesWritten,attemptTimeout:record.attemptTimeout,ended:record.ended,
      ...(error.success?{code:socketCode.safeParse(error.data.code).success?error.data.code:'UNKNOWN',
        syscall:['connect','read','write'].includes(error.data.syscall??'')?error.data.syscall:'unknown',...(Number.isInteger(error.data.errno)?{errno:error.data.errno}:{})}:{}),
    });
  })};
}
