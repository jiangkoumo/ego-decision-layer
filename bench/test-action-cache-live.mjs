// Run with ego-browser nodejs -e 'await import("/absolute/repo/bench/test-action-cache-live.mjs")'
const {ActionCache,runJevAutonomousLoop}=await import('../scripts/decider-loop.mjs');
const task=await taskSpace('phase3-cache-repair-live');
console.log('SPACE',task.spaceId);
const page=task.page('p1');
const cache=new ActionCache();
const runs=[];
try {
  for(const text of ['Jev','Jev','Ada Lovelace']) {
    await page.goto('https://en.wikipedia.org/wiki/Main_Page',{waitUntil:'domcontentloaded',timeout:25000});
    const metrics={};
    const result=await runJevAutonomousLoop(page,'Type the supplied candidate into the search box and submit',{
      text:[text],actionCache:cache,metrics,maxSteps:3,onStep:()=>{},
      check:async p=>(await p.url()).includes('/wiki/'+text.replaceAll(' ','_')),
    });
    runs.push({text,success:result.success,url:await page.url(),cacheHits:result.cacheHits,decideMs:result.phases.decideMs,requests:metrics['jev.request']||0});
  }
  const ok=runs.every(r=>r.success) && runs[0].requests>0 && runs[1].requests===0 && runs[1].cacheHits===1 && runs[1].decideMs===0 && runs[2].requests>0 && runs[2].cacheHits===0;
  console.log('LIVE',JSON.stringify({ok,runs}));process.exitCode=ok?0:1;
}finally{await task.finish({keep:[]});}
