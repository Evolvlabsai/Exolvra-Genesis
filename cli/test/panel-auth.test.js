import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PanelAuth, PanelAuthError } from '../dist/panel-auth.js';

const KEY = 'correct-access-key-with-at-least-24-characters';
const cookieHeader = login => login.cookie.split(';')[0];

test('local mode keeps one stable CSRF-protected session without requiring a key',()=>{
  const auth=new PanelAuth();assert.equal(auth.requiresLogin,false);
  const first=auth.session();assert.ok(first);assert.equal(first.csrfToken,auth.anonymousCsrf);assert.deepEqual(auth.session('unrelated=anything'),first);
  first.csrfToken='changed-by-caller';assert.equal(auth.session().csrfToken,auth.anonymousCsrf);
  assert.equal(auth.login('', '127.0.0.1').csrfToken,auth.anonymousCsrf);assert.match(auth.logout(),/Max-Age=0/);
});

test('configured access keys are validated, never retained in serialized state, and never echoed in errors',()=>{
  for(const token of ['', 'a'.repeat(23), ' '.repeat(24), 'a'.repeat(4097), 'a'.repeat(24)+'\n'])assert.throws(()=>new PanelAuth({token}),/EXOLVRA_GENESIS_PANEL_TOKEN/);
  const auth=new PanelAuth({token:KEY});assert.equal(auth.requiresLogin,true);assert.equal(auth.session(),undefined);
  assert.equal(JSON.stringify(auth).includes(KEY),false);assert.equal(Object.values(auth).includes(KEY),false);
  assert.throws(()=>auth.login('wrong-private-key','client'),error=>error instanceof PanelAuthError&&error.status===401&&!error.message.includes('wrong-private-key')&&!error.message.includes(KEY));
});

test('login creates independent opaque sessions and HTTPS-only cookie flags',()=>{
  const auth=new PanelAuth({token:KEY,secure:true}),one=auth.login(KEY,'first'),two=auth.login(KEY,'second');
  assert.match(one.cookie,/^genesis_panel_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28800; HttpOnly; SameSite=Strict; Secure$/);
  assert.notEqual(one.cookie,two.cookie);assert.notEqual(one.csrfToken,two.csrfToken);assert.notEqual(one.csrfToken,auth.anonymousCsrf);
  const session=auth.session('other=value; '+cookieHeader(one));assert.equal(session.csrfToken,one.csrfToken);assert.equal(session.id.length,43);
  session.csrfToken='mutated';assert.equal(auth.session(cookieHeader(one)).csrfToken,one.csrfToken);
  assert.equal(auth.session(cookieHeader(two)).csrfToken,two.csrfToken);
  const localHttp=new PanelAuth({token:KEY});assert.ok(!localHttp.login(KEY,'local').cookie.includes('; Secure'));
});

test('malformed, unknown and duplicate cookies never authenticate; logout invalidates only its session',()=>{
  const auth=new PanelAuth({token:KEY,secure:true}),one=auth.login(KEY,'a'),two=auth.login(KEY,'b'),header=cookieHeader(one);
  for(const value of ['genesis_panel_session=', 'genesis_panel_session=bad', 'genesis_panel_session='+('x'.repeat(43)), header+'; '+header, 'genesis_panel_session="'+header.split('=')[1]+'"', 'x'.repeat(9000)])assert.equal(auth.session(value),undefined);
  const expired=auth.logout(header);assert.match(expired,/Max-Age=0/);assert.match(expired,/HttpOnly; SameSite=Strict; Secure$/);assert.equal(auth.session(header),undefined);assert.ok(auth.session(cookieHeader(two)));
  assert.doesNotThrow(()=>auth.logout('malformed'));assert.equal(auth.session('genesis_panel_session='+auth.anonymousCsrf),undefined);
});

test('five failures throttle one address for five minutes without blocking other clients',()=>{
  const auth=new PanelAuth({token:KEY});
  for(let n=0;n<5;n++)assert.throws(()=>auth.login('wrong','blocked-client'),error=>error instanceof PanelAuthError&&error.status===401);
  assert.throws(()=>auth.login('still-wrong','blocked-client'),error=>error instanceof PanelAuthError&&error.status===429&&error.retryAfterSeconds>0&&error.retryAfterSeconds<=300);
  assert.ok(auth.session(cookieHeader(auth.login(KEY,'blocked-client'))),'a valid key remains usable when teammates share a reverse proxy address');
  assert.throws(()=>auth.login('wrong','blocked-client'),error=>error.status===401);
  assert.ok(auth.session(cookieHeader(auth.login(KEY,'other-client'))));
  const reset=new PanelAuth({token:KEY});for(let n=0;n<4;n++)assert.throws(()=>reset.login('wrong','a'));
  reset.login(KEY,'a');for(let n=0;n<5;n++)assert.throws(()=>reset.login('wrong','a'),error=>error.status===401);
});

test('sessions and failed-address tracking stay bounded under churn',()=>{
  const auth=new PanelAuth({token:KEY}),first=auth.login(KEY,'client');let last;
  for(let n=0;n<1000;n++)last=auth.login(KEY,'client');
  assert.equal(auth.session(cookieHeader(first)),undefined);assert.ok(auth.session(cookieHeader(last)));
  for(let n=0;n<5;n++)assert.throws(()=>auth.login('wrong','oldest'),error=>error.status===401);
  for(let n=0;n<1000;n++)assert.throws(()=>auth.login('wrong','address-'+n),error=>error.status===401);
  assert.ok(auth.login(KEY,'oldest'),'oldest counter is evicted rather than keeping an unbounded address table');
});

test('sessions expire against elapsed wall time and cannot be configured beyond eight hours',async()=>{
  for(const sessionTtlMs of [0,-1,1.5,Infinity,NaN,28_800_001])assert.throws(()=>new PanelAuth({token:KEY,sessionTtlMs}),/session lifetime/);
  const auth=new PanelAuth({token:KEY,sessionTtlMs:150}),login=auth.login(KEY,'client'),header=cookieHeader(login);
  assert.ok(auth.session(header));assert.match(login.cookie,/Max-Age=1;/);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(auth.session(header),undefined);
  assert.ok(auth.session(cookieHeader(auth.login(KEY,'client'))),'an expired session does not prevent a fresh sign-in');
});
