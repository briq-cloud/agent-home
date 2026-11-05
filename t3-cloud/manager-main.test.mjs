import test from 'node:test';
import assert from 'node:assert/strict';
import { startManager } from './manager-main.mjs';
test('product startup validates owner configuration before starting any broker or native process',async()=>{
 let started=false;const deps={centralRuntime:async()=>{started=true;throw Error('unexpected runtime');},spawnProcess:()=>{started=true;throw Error('unexpected spawn');}};
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example'},deps),/owner key/);
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example',T3_CLOUD_OWNER_KEY:'random-owner-key-with-at-least-32-bytes'},deps),/owner identity/);
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example/path',T3_CLOUD_OWNER_KEY:'random-owner-key-with-at-least-32-bytes'},deps),/origin/);
 assert.equal(started,false);
});
test('failure composing the manager closes the already started central runtime',async()=>{
 let closed=0,spawned=0;
 await assert.rejects(startManager({T3_CLOUD_PUBLIC_ORIGIN:'https://cloud.example',T3_CLOUD_OWNER_KEY:'owner-key-test-only-at-least-32-bytes',T3_CLOUD_OWNER_ID:'owner'}, {
  centralRuntime:async()=>({close:async()=>{closed++;}}),spawnProcess:()=>{spawned++;throw Error('unexpected spawn');},
 }),/runtime/);
 assert.equal(closed,1);assert.equal(spawned,0);
});
