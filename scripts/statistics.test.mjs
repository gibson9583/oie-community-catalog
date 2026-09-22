import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshStatistics,identity,publishedStatistics} from './statistics.mjs';
const pkg={id:'demo',repository:'https://github.com/a/b',versions:[{version:'2.0.0',installerUrl:'https://github.com/a/b/releases/download/v2.0.0/demo-2.0.0.zip'}]};
const asset=(id,name,n)=>({id,name,download_count:n});
const release=(id,version,assets)=>({id,tag_name:version,assets});
test('stars and historical downloads exclude unrelated files; repository calls deduplicated',async()=>{
 const calls=[];const api=async p=>{calls.push(p);return p==='/repos/a/b'?{stargazers_count:7}:[release(1,'v1.0.0',[asset(1,'demo-1.0.0.zip',3),asset(2,'demo-1.0.0.zip.sha256',99)]),release(2,'v2.0.0',[asset(3,'demo-2.0.0.zip',5),asset(4,'unrelated.zip',99)])];};
 const r=await refreshStatistics([pkg,{...pkg,id:'second'}],{},api,'2026-09-22T12:00:00Z');assert.equal(r.demo.metrics.downloads.count,8);assert.equal(r.demo.metrics.stars.count,7);assert.equal(calls.length,2);
});
test('failure preserves counts and original timestamps independently',async()=>{
 const old={demo:{identity:identity(pkg),metrics:{downloads:{status:'available',count:9,checkedAt:'old'},stars:{status:'available',count:4,checkedAt:'old'}}}};
 const r=await refreshStatistics([pkg],old,async p=>{if(p.endsWith('/a/b'))return {stargazers_count:0};throw Error('outage');},'new');
 assert.equal(r.demo.metrics.stars.count,0);assert.equal(r.demo.metrics.stars.checkedAt,'new');assert.deepEqual(r.demo.metrics.downloads,{status:'available',count:9,checkedAt:'old',stale:true});
 assert.deepEqual(publishedStatistics({...pkg,repository:'https://github.com/a/changed'},old.demo),{});
});
test('pagination, drafts, prereleases, duplicate assets and zero',async()=>{
 const full=Array.from({length:100},(_,i)=>({...release(i,'v2.0.0',[asset(1,'demo-2.0.0.zip',0)]),prerelease:true}));
 const r=await refreshStatistics([pkg],{},async p=>p==='/repos/a/b'?{stargazers_count:0}:p.endsWith('page=1')?full:[{...release(101,'v3.0.0',[asset(9,'demo-3.0.0.zip',100)]),draft:true}]);
 assert.equal(r.demo.metrics.downloads.count,0);
});
test('partial pagination failure publishes no partial sum',async()=>{
 const full=Array.from({length:100},(_,i)=>release(i,'v2.0.0',[asset(i,'demo-2.0.0.zip',1)]));
 const r=await refreshStatistics([pkg],{},async p=>{if(p==='/repos/a/b')return {stargazers_count:1};if(p.endsWith('page=1'))return full;throw Error('rate limit');});
 assert.equal(r.demo.metrics.downloads.status,'unavailable');assert.equal(r.demo.metrics.downloads.count,undefined);
});
test('content can have stars without release downloads; unsupported hosts never fetched',async()=>{
 let calls=0;const r=await refreshStatistics([{...pkg,versions:[{version:'1',installerUrl:'https://raw.githubusercontent.com/a/b/main/test.xml'}]}, {...pkg,id:'external',repository:'https://other.test/a/b'}],{},async()=>{calls++;return {stargazers_count:3};});
 assert.equal(calls,1);assert.equal(r.demo.metrics.stars.count,3);assert.equal(r.demo.metrics.downloads.status,'unavailable');assert.equal(r.external.metrics.stars.status,'unavailable');
});
test('large embedded asset lists paginate assets, exclude sources and deduplicate',async()=>{
 const assets=Array.from({length:100},()=>asset(1,'demo-2.0.0.zip',2));
 const r=await refreshStatistics([pkg],{},async p=>p==='/repos/a/b'?{stargazers_count:1}:p.includes('/assets?')?(p.endsWith('page=1')?assets:[asset(2,'demo-2.0.0-sources.zip',999)]):[release(1,'v2.0.0',assets)]);
 assert.equal(r.demo.metrics.downloads.count,2);
});
