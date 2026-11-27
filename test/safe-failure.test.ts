import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeFailure } from './support/safe-failure.js';

await test('worker diagnostics classify causes without emitting raw exception or credential text', () => {
  const error = new Error('private connection information', { cause: new Error('Connection terminated due to connection timeout') });
  assert.equal(safeFailure(error).reason, 'connection-timeout');
  assert.equal(safeFailure({ name: 'PrismaClientKnownRequestError', code: 'P1008', message: 'private' }).category, 'database');
  assert.equal(safeFailure({name:'PrismaClientKnownRequestError',code:'P1008',meta:{driverAdapterError:{name:'DriverAdapterError',cause:{kind:'SocketTimeout'}}}}).driverKind,'SocketTimeout');
  assert.equal(safeFailure({code:'ETIMEDOUT',syscall:'connect',message:'private'}).socketOperation,'connect');
  assert.equal(safeFailure(new AggregateError([{code:'ETIMEDOUT',syscall:'connect',message:'private'}],'private')).socketOperation,'connect');
  assert.equal(safeFailure({ code: '57014' }).reason, 'statement-timeout');
  assert.equal(safeFailure(new Error('TASK_EXECUTION_LEASE_LOST')).reason, 'lease');
  const cyclic = { message: 'private password', cause: undefined as unknown }; cyclic.cause = cyclic;
  assert.equal(safeFailure(cyclic).reason, 'unknown');
  assert.doesNotMatch(JSON.stringify([safeFailure(error), safeFailure(cyclic), safeFailure({ code: 'private-password' })]), /private|password/);
});
