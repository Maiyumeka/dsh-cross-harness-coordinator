import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {packageFiles, sha256} from './archive.mjs';

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function desktopVersion(asar) {
  const fd = fs.openSync(asar, 'r');
  try {
    const header = Buffer.alloc(16); fs.readSync(fd, header, 0, 16, 0);
    const jsonSize = header.readUInt32LE(12), headerSize = header.readUInt32LE(4);
    if (jsonSize > 32 * 1024 * 1024 || jsonSize + 8 > headerSize) throw new Error('invalid ASAR header');
    const json = Buffer.alloc(jsonSize); fs.readSync(fd, json, 0, jsonSize, 16);
    const entry = JSON.parse(json.toString()).files['package.json'];
    if (!entry || entry.unpacked || entry.size > 1024 * 1024) throw new Error('invalid ASAR manifest');
    const bytes = Buffer.alloc(entry.size); fs.readSync(fd, bytes, 0, bytes.length, 8 + headerSize + Number(entry.offset));
    return JSON.parse(bytes.toString()).version;
  } finally { fs.closeSync(fd); }
}
function sessionFiles(home) {
  const root = path.join(home, 'sessions'), ids = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) throw new Error('session inventory cannot follow links');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file); else if (entry.isFile()) ids.push(path.relative(root, file));
    }
  }
  walk(root); return ids.sort();
}
export function check(options = {}) {
  const releaseFile = path.resolve(options.release ?? path.join(import.meta.dirname, '..', 'dist', 'agent-install.json'));
  const release = readJson(releaseFile);
  const home = fs.realpathSync(options.home ?? process.env.DSH_HOME ?? release.defaults.home);
  const profile = options.profile ?? release.defaults.profile;
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('invalid profile name');
  const profileDir = fs.realpathSync(path.join(home, 'profiles', profile));
  if (path.dirname(profileDir).toLowerCase() !== fs.realpathSync(path.join(home, 'profiles')).toLowerCase()) throw new Error('profile escapes DSH_HOME');
  const packed = packageFiles(release.archive);
  if (sha256(packed.archive) !== release.sha256) throw new Error('release checksum mismatch');
  if (packed.manifest.name !== release.name || packed.manifest.version !== release.version) throw new Error('release identity mismatch');
  const hashes = Object.fromEntries([...packed.files].map(([name, bytes]) => [name, sha256(bytes)]));
  if (JSON.stringify(hashes) !== JSON.stringify(release.files)) throw new Error('release file list mismatch');
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) if (packed.manifest.scripts?.[lifecycle]) throw new Error('unexpected install script');
  if(!release.defaults.cli||!release.defaults.asar)throw new Error('请设置COORDINATOR_DSH_CLI与COORDINATOR_DSH_ASAR后重新生成发布清单；不会自动修改宿主配置');
  const cliVersion = readJson(path.resolve(path.dirname(release.defaults.cli), '..', 'package.json')).version;
  const appVersion = desktopVersion(release.defaults.asar);
  if (appVersion !== release.runtimeVersion || cliVersion !== appVersion) throw new Error(`runtime mismatch: desktop ${appVersion}, CLI ${cliVersion}, expected ${release.runtimeVersion}`);
  const manifest = readJson(path.join(profileDir, 'package.json'));
  const canonicalName=release.canonicalName??release.name,identities=[];
  for(const name of Object.keys(manifest.dependencies??{})){const file=path.join(profileDir,'node_modules',name,'package.json');if(!fs.existsSync(file))continue;const pkg=readJson(file);if(pkg.name===canonicalName||pkg.dshCoordinator?.canonicalName===canonicalName)identities.push({name,version:pkg.version});}
  const previousBundles=(manifest.dsh?.profile?.bundles??[]).filter(name=>identities.some(pkg=>pkg.name===name));
  const installedVersion=identities.find(pkg=>previousBundles.includes(pkg.name))?.version??identities[0]?.version??null;
  const stateFile=path.join(home,'storages','cross-harness-coordinator','state.json');
  const pendingTasks=fs.existsSync(stateFile)?Object.values(readJson(stateFile).sessions??{}).flatMap(s=>(s.tasks??[]).filter(t=>['running','stopping','queued','awaiting_review'].includes(t.status)).map(t=>({session:s.id,id:t.id,status:t.status}))):[];
  const pendingConnections=fs.existsSync(stateFile)?Object.values(readJson(stateFile).endpoints??{}).filter(e=>e.connection?.state==='checking').map(e=>({id:e.id,owner:e.owner})):[];
  return {release, home, profile, profileDir, manifest, hashes, runtimeVersion: appVersion, sessions: sessionFiles(home),installedVersion,previousBundles,stateFile,pendingTasks,pendingConnections};
}
export function prepare(options = {}) {
  const checked = check(options), root = path.resolve(options.backupRoot ?? checked.release.defaults.backupRoot);
  if(checked.installedVersion&&(checked.pendingTasks.length||checked.pendingConnections.length))throw new Error('协调工作或协议连接检查尚未空闲，请先核对进度或等工作结束再更新');
  // The backup is configuration plus an inventory, not a pretend session-data backup.
  fs.mkdirSync(root, {recursive: true});
  const dir = path.join(root, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  fs.mkdirSync(dir);
  const saved = [];
  const copy = (source, destination) => {
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (sha256(fs.readFileSync(source)) !== sha256(fs.readFileSync(destination))) throw new Error('backup verification failed');
    saved.push({source, file: path.relative(dir, destination), sha256: sha256(fs.readFileSync(destination))});
  };
  for (const entry of fs.readdirSync(checked.profileDir, {withFileTypes: true})) {
    if (entry.isFile()) copy(path.join(checked.profileDir, entry.name), path.join(dir, 'profile', entry.name));
  }
  for (const name of ['cordis.patch.yml', 'settings.yaml', 'settings.yaml.imported']) {
    const file = path.join(checked.home, name);
    if (fs.existsSync(file)) copy(file, path.join(dir, 'home', name));
  }
  if(fs.existsSync(checked.stateFile))copy(checked.stateFile,path.join(dir,'coordinator','state.json'));
  const receipt = {schema: 1, createdAt: new Date().toISOString(), release: {name: checked.release.name, version: checked.release.version, sha256: checked.release.sha256}, home: checked.home, profile: checked.profile, profileDir: checked.profileDir, manifest: checked.manifest,previousBundles:checked.previousBundles, sessions: checked.sessions, saved};
  fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2));
  return {status: 'prepared',operation:checked.installedVersion?'update':'install',installedVersion:checked.installedVersion,previousBundles:checked.previousBundles, backup: dir, runtimeVersion: checked.runtimeVersion, archive: checked.release.archive, sha256: checked.release.sha256, sessionFiles: checked.sessions.length, install: checked.release.installation};
}
export function verify(options = {}) {
  if (!options.backup) throw new Error('verification requires --backup from prepare');
  const checked = check(options), backup = path.resolve(options.backup), before = readJson(path.join(backup, 'receipt.json'));
  if (before.home !== checked.home || before.profile !== checked.profile || before.release.sha256 !== checked.release.sha256) throw new Error('backup target or release mismatch');
  for (const item of before.saved) if (sha256(fs.readFileSync(path.join(backup, item.file))) !== item.sha256) throw new Error('backup file changed');
  const missingDependencies = Object.keys(before.manifest.dependencies ?? {}).filter(name => !(name in (checked.manifest.dependencies ?? {})));
  const changedDependencies = Object.entries(before.manifest.dependencies ?? {}).filter(([name, spec]) => name !== checked.release.name && checked.manifest.dependencies?.[name] !== spec).map(([name]) => name);
  const lostBundles = (before.manifest.dsh?.profile?.bundles ?? []).filter(name => !(checked.manifest.dsh?.profile?.bundles ?? []).includes(name)&&!(before.previousBundles??[]).includes(name));
  const missingSessions = before.sessions.filter(id => !checked.sessions.includes(id));
  const errors = [];
  if (missingDependencies.length || changedDependencies.length || lostBundles.length || missingSessions.length) errors.push('existing profile entries or session files changed/disappeared');
  const pluginDir = path.join(checked.profileDir, 'node_modules', checked.release.name);
  for (const [name, expected] of Object.entries(checked.hashes)) {
    const file = path.join(pluginDir, name);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expected) errors.push(`installed file mismatch: ${name}`);
  }
  if (!checked.manifest.dependencies?.[checked.release.name] || !checked.manifest.dsh?.profile?.bundles?.includes(checked.release.name)) errors.push('bundle not installed and enabled');
  if (errors.length) throw new Error(errors.join('; '));
  return {status: 'installed_runtime_check_required', name: checked.release.name, version: checked.release.version, backup, filesVerified: Object.keys(checked.hashes).length, retainedDependencies: Object.keys(before.manifest.dependencies ?? {}).length, retainedSessionFiles: before.sessions.length, runtimeChecks: ['native installer application must be applied', 'list_plugins shows host and client active without errors', 'seven coordinator tools discoverable in the current conversation', 'DSH Settings → 协调器 visible and status RPC responds'], note: 'Disk verification does not prove runtime activation. No real Harness has been connected.'};
}
function main() {
  const args = process.argv.slice(2), action = args.shift(), options = {};
  const keys = {'--release': 'release', '--home': 'home', '--profile': 'profile', '--backup-root': 'backupRoot', '--backup': 'backup'};
  while (args.length) {const key = keys[args.shift()]; if (!key || !args.length) throw new Error('invalid arguments'); options[key] = args.shift();}
  const output = action === 'check' ? (() => {const c = check(options); return {status: 'ready',operation:c.installedVersion?'update':'install',installedVersion:c.installedVersion,pendingTasks:c.pendingTasks,pendingConnections:c.pendingConnections, name: c.release.name, version: c.release.version, runtimeVersion: c.runtimeVersion, profileDir: c.profileDir, archive: c.release.archive, sha256: c.release.sha256, sessionFiles: c.sessions.length, install: c.release.installation};})() : action === 'prepare' ? prepare(options) : action === 'verify' ? verify(options) : (() => {throw new Error('use check, prepare or verify');})();
  console.log(JSON.stringify(output, null, 2));
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {main();} catch (error) {console.log(JSON.stringify({status: 'failed', error: error.message})); process.exitCode = 1;}
}
