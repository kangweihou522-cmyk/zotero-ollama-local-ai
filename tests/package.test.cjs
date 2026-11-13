/* Regression for Zotero's real manifest parser requirements, not a simulated host installation. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const readJSON=file=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const manifest=readJSON('addon/manifest.json');
const packageJSON=readJSON('package.json');
const updates=readJSON('updates.json');

function temporary(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ollama-local-ai-package-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}

function brokenFixture(t,mutateManifest,mutateUpdates){
  const dir=temporary(t);
  fs.mkdirSync(path.join(dir,'scripts'));
  fs.mkdirSync(path.join(dir,'addon'));
  fs.copyFileSync(path.join(root,'scripts/build.py'),path.join(dir,'scripts/build.py'));
  const addon=structuredClone(manifest), index=structuredClone(updates);
  mutateManifest?.(addon);mutateUpdates?.(index);
  fs.writeFileSync(path.join(dir,'addon/manifest.json'),JSON.stringify(addon));
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(packageJSON));
  fs.writeFileSync(path.join(dir,'updates.json'),JSON.stringify(index));
  return spawnSync('python3',[path.join(dir,'scripts/build.py')],{encoding:'utf8'});
}

test('manifest includes the mandatory Zotero parser fields and a real update endpoint',()=>{
  // Official Zotero 10.0.8 app/scripts/fetch_xulrunner explicitly emits
  // manifestError for each of these absent fields before addon startup.
  const target=manifest.applications.zotero;
  for(const field of ['id','update_url','strict_max_version']){
    assert.equal(typeof target[field],'string');assert.ok(target[field].trim());
  }
  assert.equal(target.update_url,'https://raw.githubusercontent.com/kangweihou522-cmyk/zotero-ollama-local-ai/main/updates.json');
  assert.equal(manifest.version,packageJSON.version);
  const current=updates.addons[target.id].updates.filter(entry=>entry.version===manifest.version);
  assert.equal(current.length,1);
  assert.deepEqual(current[0].applications.zotero,{
    strict_min_version:target.strict_min_version,strict_max_version:target.strict_max_version
  });
  assert.equal(current[0].update_link,`https://github.com/kangweihou522-cmyk/zotero-ollama-local-ai/raw/refs/tags/v${manifest.version}/downloads/ollama-local-ai-${manifest.version}.xpi`);
});

test('build rejects the original missing-update-url installation defect before writing an XPI',t=>{
  const result=brokenFixture(t,addon=>delete addon.applications.zotero.update_url);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/applications\.zotero\.update_url/);
  assert.equal(result.stdout,'');
});

test('build rejects mismatched release downloads and compatibility ranges',t=>{
  const result=brokenFixture(t,null,index=>{index.addons[manifest.applications.zotero.id].updates[0].update_link='https://example.com/old.xpi';});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/matching versioned Git tag and XPI/);
  const range=brokenFixture(t,null,index=>{index.addons[manifest.applications.zotero.id].updates[0].applications.zotero.strict_max_version='9.0.*';});
  assert.notEqual(range.status,0);
  assert.match(range.stderr,/compatibility ranges must match/);
});

test('built XPI has a root manifest and bootstrap, and source archive includes update metadata and packaging tests',t=>{
  const dir=temporary(t);
  const built=spawnSync('python3',[path.join(root,'scripts/build.py'),'--output',dir],{encoding:'utf8'});
  assert.equal(built.status,0,built.stderr);
  const inspect=spawnSync('python3',['-c',[
    'import json,sys,zipfile',
    'from pathlib import Path',
    'directory=Path(sys.argv[1]);version=sys.argv[2];root=Path(sys.argv[3])',
    'with zipfile.ZipFile(directory/f"ollama-local-ai-{version}.xpi") as z:',
    ' assert z.testzip() is None',
    ' assert "manifest.json" in z.namelist() and "bootstrap.js" in z.namelist()',
    ' assert json.loads(z.read("manifest.json"))["applications"]["zotero"]["update_url"]',
    'with zipfile.ZipFile(directory/f"ollama-local-ai-{version}-source.zip") as z:',
    ' assert z.testzip() is None',
    ' assert "updates.json" in z.namelist() and "tests/package.test.cjs" in z.namelist()',
    ' if (root/".github/workflows/native-smoke.yml").is_file():',
    '  assert ".github/workflows/native-smoke.yml" in z.namelist()',
    ' assert not any(name.startswith((".git/","downloads/","node_modules/")) for name in z.namelist())',
    'print("archives verified")'
  ].join('\n'),dir,manifest.version,root],{encoding:'utf8'});
  assert.equal(inspect.status,0,inspect.stderr);
  assert.match(inspect.stdout,/archives verified/);
});
