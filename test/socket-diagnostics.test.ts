import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createConnection,createServer} from 'node:net';
import {once} from 'node:events';
import {captureSocketDiagnostics} from './support/socket-diagnostics.js';

await test('socket diagnostics distinguish connected sockets and omit endpoint/payload data',async()=>{
  const server=createServer(socket=>{socket.end('private-payload');});server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');const capture=captureSocketDiagnostics();
  try{
    const socket=createConnection(address.port,'127.0.0.1');socket.resume();await once(socket,'close');
    const records=capture.snapshot();assert.equal(records.length,1);assert.equal(records[0]?.connected,true);assert.equal(records[0]?.ended,true);
    assert.equal(records[0]?.bytesRead,Buffer.byteLength('private-payload'));assert.doesNotMatch(JSON.stringify(records),/private|127\.0\.0\.1/);
  }finally{capture.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

await test('socket diagnostics capture a failed loopback connection without leaking addresses',async()=>{
  const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const address=reservation.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const capture=captureSocketDiagnostics();
  try{
    const socket=createConnection(address.port,'127.0.0.1');await new Promise<void>(resolve=>socket.once('close',()=>resolve()));
    const records=capture.snapshot();assert.equal(records.length,1);assert.equal(records[0]?.connected,false);
    assert.equal(records[0]?.code,'ECONNREFUSED');assert.equal(records[0]?.syscall,'connect');assert.equal(records[0]?.bytesRead,0);
    assert.doesNotMatch(JSON.stringify(records),/127\.0\.0\.1/);
  }finally{capture.close();}
});
