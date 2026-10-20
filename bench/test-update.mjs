// Offline update integration: real bare Git remote, isolated copies and manager stubs.
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const {fileURLToPath} = await import('node:url');
const {spawnSync} = await import('node:child_process');
const assert = (await import('node:assert')).strict;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-update-'));
const home = path.join(root, 'home');
const fakeBin = path.join(root, 'fakebin');
fs.mkdirSync(home); fs.mkdirSync(fakeBin);
let pass=0;
const check=(name,fn)=>{fn();pass++;console.log('ok '+name);};
const env={...process.env,HOME:home,PATH:`${fakeBin}${path.delimiter}${process.env.PATH}`,BINDIR:path.join(home,'bin'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(root,'gitconfig'),EGO_JEV_LIB:'/missing/engine',TYPESAFE_API_KEY:''};
const run=(file,args,cwd=root,extra={})=>spawnSync(file,args,{cwd,env:{...env,...extra},encoding:'utf8',timeout:15000});
const git=(cwd,...args)=>{const r=run('git',args,cwd);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const write=(p,s,mode)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s,mode?{mode}:undefined);};
const fixture=dir=>{
 fs.mkdirSync(dir,{recursive:true});
 // Include the legacy compatibility entry in installation fixtures.
 for(const f of ['SKILL.md','scripts/ego-decision-layer','scripts/ego-jev','scripts/update.sh','update.sh']) { // legacy alias
  fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.copyFileSync(path.join(REPO,f),path.join(dir,f));
 }
 write(path.join(dir,'scripts/wire-agent-skills.sh'),'#!/bin/bash\nprintf "%s\\n" "$*" >> "$WIRE_LOG"\nexit "${WIRE_EXIT:-0}"\n');
};
write(path.join(fakeBin,'ego-browser'),'#!/bin/bash\nprintf "unexpected browser\\n" >&2\nexit 99\n',0o755);
write(path.join(fakeBin,'npx'),'#!/bin/bash\nprintf "%s\\n" "$*" > "$NPX_LOG"\npwd >> "$NPX_LOG"\nif [ "${NPX_REPLACE:-0}" = 1 ]; then printf "#!/bin/bash\\nexit 91\\n" > "$INSTALL_ROOT/scripts/update.sh"; fi\nprintf "%s\\n" "${NPX_MESSAGE:-Updated ego-decision-layer}"\nexit "${NPX_EXIT:-0}"\n',0o755);
try {
 const source=path.join(root,'source'),remote=path.join(root,'remote.git'),clone=path.join(root,'clone with spaces');
 fixture(source);git(source,'init','-b','main');git(source,'config','user.email','test@example.invalid');git(source,'config','user.name','Update Test');git(source,'add','.');git(source,'commit','-m','initial');git(root,'init','--bare',remote);git(source,'remote','add','origin',remote);git(source,'push','-u','origin','main');git(root,'clone','--branch','main',remote,clone);
 write(path.join(source,'revision.txt'),'new revision\n');git(source,'add','.');git(source,'commit','-m','new revision');git(source,'push');
 const wireLog=path.join(root,'wire.log');const call=(dir,args=[],extra={})=>run('bash',[path.join(dir,'scripts/ego-decision-layer'),...args],root,{WIRE_LOG:wireLog,...extra});
 let r=call(clone,['--version']);check('version reads metadata without engine/browser',()=>{assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ego-decision-layer \d+\.\d+\.\d+ \([a-f0-9]+\)/);});
 r=call(clone,['update','--help']);check('update help has no side effects',()=>{assert.equal(r.status,0);assert.ok(!fs.existsSync(wireLog));assert.ok(!fs.existsSync(env.BINDIR));});
 r=call(clone,['update']);check('Git update works outside installation directory',()=>{assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(git(clone,'rev-parse','HEAD'),git(source,'rev-parse','HEAD'));assert.equal(fs.readFileSync(wireLog,'utf8').trim(),'--if-enabled');assert.equal(fs.realpathSync(path.join(env.BINDIR,'ego-decision-layer')),fs.realpathSync(path.join(clone,'scripts/ego-decision-layer')));});
 r=call(clone,['--update']);check('update alias supports already current checkout',()=>assert.equal(r.status,0,r.stderr));
 write(path.join(clone,'local.txt'),'keep');r=call(clone,['update']);check('untracked notes survive update',()=>{assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(fs.readFileSync(path.join(clone,'local.txt'),'utf8'),'keep');});fs.unlinkSync(path.join(clone,'local.txt'));
 const tracked=path.join(clone,'revision.txt');fs.writeFileSync(tracked,'local tracked change');r=call(clone,['update']);check('tracked changes stop update and remain intact',()=>{assert.equal(r.status,1);assert.match(r.stderr,/未提交改动/);assert.equal(fs.readFileSync(tracked,'utf8'),'local tracked change');});fs.writeFileSync(tracked,'new revision\n');
 write(path.join(clone,'collision.txt'),'local note');write(path.join(source,'collision.txt'),'remote file');git(source,'add','.');git(source,'commit','-m','remote collision');git(source,'push');r=call(clone,['update']);check('Git refuses untracked path collision without overwriting',()=>{assert.notEqual(r.status,0);assert.equal(fs.readFileSync(path.join(clone,'collision.txt'),'utf8'),'local note');assert.ok(!r.stdout.includes('更新检查与入口刷新完成'));});fs.unlinkSync(path.join(clone,'collision.txt'));r=call(clone,['update']);assert.equal(r.status,0,r.stderr);
 git(clone,'remote','set-url','origin',path.join(root,'missing.git'));r=call(clone,['update']);check('failed pull never claims update completed',()=>{assert.notEqual(r.status,0);assert.ok(!r.stdout.includes('更新检查与入口刷新完成'));});git(clone,'remote','set-url','origin',remote);
 git(clone,'checkout','--detach');r=call(clone,['update']);check('pinned tag/commit does not silently switch branch',()=>{assert.equal(r.status,1);assert.match(r.stderr,/固定/);});git(clone,'checkout','main');
 const wt=path.join(root,'linked worktree');git(clone,'worktree','add','-b','test-worktree',wt);git(wt,'branch','--set-upstream-to=origin/main');r=call(wt,['update']);check('Git worktrees with .git file are supported',()=>assert.equal(r.status,0,r.stdout+r.stderr));
 r=call(clone,['update'],{WIRE_EXIT:'7'});check('route refresh failure propagates',()=>assert.equal(r.status,7));
 r=call(clone,['update','--test']);check('smoke failure propagates without success message',()=>{assert.notEqual(r.status,0);assert.match(r.stdout,/浏览器冒烟测试/);assert.ok(!r.stdout.includes('更新检查与入口刷新完成'));});
 r=call(clone,['update'],{BINDIR:path.join(root,'custom-bin')});check('custom command directory refreshed with PATH hint',()=>{assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/不在 PATH/);assert.equal(fs.realpathSync(path.join(root,'custom-bin','ego-decision-layer')),fs.realpathSync(path.join(clone,'scripts/ego-decision-layer')));});
 r=call(clone,['update','--bogus']);check('invalid update option exit 2',()=>assert.equal(r.status,2));
 const copy=path.join(home,'.agents/skills/ego-decision-layer');fixture(copy);const log=path.join(root,'npx.log');const copEnv={NPX_LOG:log,INSTALL_ROOT:copy};
 r=call(copy,['update'],copEnv);check('unmanaged copy fails without invoking package manager',()=>{assert.equal(r.status,1);assert.ok(!fs.existsSync(log));});
 write(path.join(home,'.agents/.skill-lock.json'),JSON.stringify({version:3,skills:{'ego-decision-layer':{source:'jiangkoumo/ego-decision-layer'}}}));
 r=call(copy,['update'],{...copEnv,NPX_REPLACE:'1'});check('global copy updates only named skill and survives its script being replaced',()=>{assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(fs.readFileSync(log,'utf8').split('\n')[0],'--yes skills update ego-decision-layer --global --yes');});
 fixture(copy);r=call(copy,['update'],{...copEnv,NPX_EXIT:'6'});check('skills failure propagates',()=>{assert.equal(r.status,6);assert.ok(!r.stdout.includes('更新检查与入口刷新完成'));});
 for(const message of ['Failed to check skills from source','1 skill(s) cannot be checked automatically:','No installed skills found matching: ego-decision-layer']) {r=call(copy,['update'],{...copEnv,NPX_MESSAGE:message});check('manager exit 0 with skipped/failed check is not success',()=>assert.equal(r.status,1,r.stdout+r.stderr));}
 const project=path.join(root,'project'),pcopy=path.join(project,'.agents/skills/ego-decision-layer');fixture(pcopy);write(path.join(project,'skills-lock.json'),JSON.stringify({version:1,skills:{'ego-decision-layer':{source:'jiangkoumo/ego-decision-layer'}}}));
 r=call(pcopy,['update'],{NPX_LOG:log,INSTALL_ROOT:pcopy});check('project copy preserves scope and project cwd',()=>{assert.equal(r.status,0,r.stdout+r.stderr);const lines=fs.readFileSync(log,'utf8').trim().split('\n');assert.equal(lines[0],'--yes skills update ego-decision-layer --project --yes');assert.equal(fs.realpathSync(lines[1]),fs.realpathSync(project));});
 r=run('bash',[path.join(clone,'update.sh'),'--help']);check('legacy root update entry still works',()=>assert.equal(r.status,0,r.stderr));
 const link=path.join(root,'entry');fs.symlinkSync(path.join(clone,'scripts/ego-decision-layer'),link);r=run('bash',[link,'--version']);check('PATH symlink version resolves actual installation',()=>assert.equal(r.status,0,r.stderr));
 console.log(`Update integration: ${pass} passed`);
} finally {fs.rmSync(root,{recursive:true,force:true});}
