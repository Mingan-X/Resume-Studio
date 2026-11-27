import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hashPassword,verifyPassword} from '../src/modules/auth/password.js';
import {createSessionToken,csrfFor,readSessionCookie,requireCsrf,sessionCookie,tokenHash} from '../src/modules/auth/session-token.js';
await test('scrypt hashes random salts, verifies exact passwords and rejects malformed stored parameters',async()=>{
 const password='test-only-long-password-123',a=await hashPassword(password),b=await hashPassword(password);assert.notEqual(a,b);assert.ok(!a.includes(password));
 assert.equal(await verifyPassword(password,a),true);assert.equal(await verifyPassword(password+'x',a),false);assert.equal(await verifyPassword(password,null),false);
 await assert.rejects(verifyPassword(password,'scrypt-v1$bad'));await assert.rejects(hashPassword('short'));
});
await test('session cookie flags, token hash and CSRF origin checks fail closed on duplicates and mismatches',()=>{
 const token=createSessionToken(),cookie=sessionCookie(token,600);assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);assert.ok(!tokenHash(token).includes(token));
 assert.equal(readSessionCookie(cookie),token);assert.equal(readSessionCookie(`${cookie}; __Host-resume_session=${token}`),null);
 requireCsrf(token,csrfFor(token),'https://resume.example','https://resume.example');
 assert.throws(()=>requireCsrf(token,csrfFor(token),'https://evil.example','https://resume.example'));
 assert.throws(()=>requireCsrf(token,csrfFor(createSessionToken()),'https://resume.example','https://resume.example'));
});
