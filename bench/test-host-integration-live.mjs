// Live integration: node bench/test-host-integration-live.mjs [--suite] [--suite-only] [--wiki]
// Requires Node 22+, Chrome, and Jev credentials unless --suite-only.
// Default live tasks: HN navigation, local form, shared Bash CLI; --wiki adds a variable online task.
// Temporary profile and local fixture server are owned and cleaned by this process.
// Cross-worktree overrides: EGO_JEV_CDP_HOST, EGO_CDP_RUNNER, EGO_HOST_ACCEPTANCE_SUITE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
async function execCli(args, env) {
  const child = spawn('bash', args, {cwd:repo, env, detached:process.platform!=='win32', stdio:['ignore','pipe','pipe']});
  let stdout=''; let stderr=''; let timedOut=false;
  child.stdout.on('data', data=>{stdout+=data.toString();});
  child.stderr.on('data', data=>{stderr+=data.toString();});
  const stop=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;stop();},45000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(timedOut,false,'shared CLI exceeded time budget');
    assert.equal(code,0,stderr.slice(-2000));
    return {stdout,stderr};
  } finally { clearTimeout(timer); }
}
const repo=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostPath=process.env.EGO_JEV_CDP_HOST || repo+'/scripts/hosts/cdp-host.mjs';
const runnerPath=process.env.EGO_CDP_RUNNER || repo+'/scripts/run-cdp-task.mjs';
const suitePath=process.env.EGO_HOST_ACCEPTANCE_SUITE || repo+'/bench/host-acceptance/suite.mjs';
const {connectCdpHost}=await import(hostPath);
const {runCdpTask}=await import(runnerPath);
const engine=await import(repo+'/scripts/decider-loop.mjs');
const temp=await mkdtemp(join(tmpdir(),'ego-p1-integration-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=createServer((req,res)=>{
  res.setHeader('content-type','text/html; charset=utf-8');
  if(req.url.startsWith('/done'))res.end('<title>Submitted</title><h1 id="done">Submission complete</h1>');
  else res.end('<!doctype html><title>Search fixture</title><form action="/done"><label>Query <input name="q" aria-label="Query"></label><button type="submit">Search</button></form>');
});
let chrome; let chromeError; let chromeLog='';
let endpoint; let sentinel; let suiteHost;
const reports=[];
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const fixture='http://127.0.0.1:'+server.address().port;
  chrome=spawn(process.env.EGO_CDP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+join(temp,'profile'),'about:blank'],{stdio:['ignore','ignore','pipe']});
  chrome.on('error',err=>{chromeError=err;});
  console.log(JSON.stringify({event:'chrome_started',pid:chrome.pid}));
  chrome.stderr.on('data',chunk=>{chromeLog+=chunk.toString();});
  const deadline=Date.now()+15000;
  while(!endpoint&&Date.now()<deadline){if(chromeError)throw chromeError;endpoint=chromeLog.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];if(!endpoint)await sleep(50);}
  assert.ok(endpoint,'Chrome devtools endpoint ready');
  sentinel=await connectCdpHost({endpoint});
  await sentinel.page.goto('about:blank');
  await sentinel.page.evaluate(()=>{document.title='User-owned sentinel';window.__sentinel=42;});
  if(process.argv.includes('--suite')){
    const {runHostAcceptance}=await import(suitePath);
    suiteHost=await connectCdpHost({endpoint});
    const report=await runHostAcceptance(suiteHost.page,{host:'external-chrome',engine,onTask:r=>console.log(JSON.stringify({event:'acceptance',id:r.id,metrics:r.metrics,verification:r.verification}))});
    reports.push({kind:'controlled-dom',summary:report.summary});
    assert.equal(report.summary.total,12);
    assert.equal(report.summary.taskFailed,0,JSON.stringify(report.summary));
    await suiteHost.close({keepPage:false});suiteHost=null;
  }
  if(!process.argv.includes('--suite-only')){
    const tasks=[{id:'wiki-search',url:'https://en.wikipedia.org/wiki/Main_Page',until:'/wiki/Jev',texts:['Jev'],goal:'type Jev into the search box and submit'}, {id:'hn-navigation',url:'https://news.ycombinator.com',until:'/newcomments',goal:'open new, then open comments'}, {id:'form-submit',url:fixture,until:'/done?q=integration',texts:['integration'],goal:'type integration in Query and submit the Search form'}];
    for(const task of tasks.filter(t=>process.argv.includes('--wiki')||t.id!=='wiki-search')){
      const r=await runCdpTask({...task,cdpEndpoint:endpoint,steps:5,forceViewport:'1280x900',cache:false,extractionModel:null},{engine,connectCdpHost,installSignalHandlers:false,onLog:()=>{}});
      reports.push({id:task.id,success:r.success,verified:r.verified,reason:r.reason,url:r.url,steps:r.steps,serverModels:r.serverModels,actions:r.actions,connection:r.connection});
      console.log(JSON.stringify({event:'live_task',id:task.id,success:r.success,verified:r.verified,reason:r.reason,url:r.url,steps:r.steps,serverModels:r.serverModels,released:r.connection.released}));
      assert.equal(r.success,true,task.id+': '+JSON.stringify({reason:r.reason,error:r.error,url:r.url}));
      assert.equal(r.verified,true,task.id+' verified');
      assert.ok(r.url.includes(task.until));
      assert.equal(r.connection.released,true);
    }
    // Exercise the real shared Bash CLI with actual runner/host, staged outside user installation.
    const staged=join(temp,'cli');await mkdir(join(staged,'scripts'),{recursive:true});
    await copyFile(repo+'/scripts/ego-decision-layer',join(staged,'scripts/ego-decision-layer'));
    await symlink(runnerPath,join(staged,'scripts/run-cdp-task.mjs'));
    await symlink(repo+'/scripts/decider-loop.mjs',join(staged,'scripts/decider-loop.mjs'));
    const cli=await execCli([join(staged,'scripts/ego-decision-layer'),'--cdp-endpoint',endpoint,'--no-cache','--force-viewport','1280x900','--url',fixture,'--until','/done?q=cli-check','--text','cli-check','--steps','5','type cli-check in Query and submit the Search form'],{...process.env,EGO_JEV_NO_WIRE:'1',EGO_JEV_CDP_HOST:hostPath});
    const r=JSON.parse(cli.stdout);assert.equal(r.success,true);assert.equal(r.verified,true);assert.ok(r.url.includes('/done?q=cli-check'));assert.equal(r.connection.released,true);
    reports.push({id:'shared-cli',success:r.success,verified:r.verified,url:r.url,reason:r.reason,serverModels:r.serverModels});
    console.log(JSON.stringify({event:'live_cli',...reports.at(-1)}));
  }
  assert.equal(await sentinel.page.evaluate(()=>window.__sentinel),42,'unrelated target preserved');
  console.log(JSON.stringify({event:'verified',reports:reports.map(({actions,...rest})=>rest),sentinelPreserved:true}));
}finally{
  try {
    for(const host of [suiteHost,sentinel])if(host)try{await host.close({keepPage:false});}catch(err){console.error('Host cleanup:',err.message);}
    server.closeAllConnections();
    if(server.listening)await new Promise(r=>server.close(r));
    if(chrome?.pid){
      if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGTERM');await Promise.race([new Promise(r=>chrome.once('exit',r)),sleep(5000)]);}
      if(chrome.exitCode===null&&chrome.signalCode===null){chrome.kill('SIGKILL');await new Promise(r=>chrome.once('exit',r));}
      let alive=true;try{process.kill(chrome.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      console.log(JSON.stringify({event:'cleanup',pid:chrome.pid,alive,exitCode:chrome.exitCode,signal:chrome.signalCode}));
      assert.equal(alive,false,'temporary Chrome stopped');
    }
  } finally { await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
}
