import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {packageFiles, sha256} from './archive.mjs';
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const archive = path.join(root, 'dist', `${pkg.name}-${pkg.version}.tgz`);
const contents = packageFiles(archive);
const localFile=path.join(root,'.local-install.json');
const local=fs.existsSync(localFile)?JSON.parse(fs.readFileSync(localFile,'utf8')):{};
const defaults={home:process.env.DSH_HOME||local.home||path.join(os.homedir(),'.dsh'),profile:process.env.COORDINATOR_DSH_PROFILE||local.profile||'desktop',cli:process.env.COORDINATOR_DSH_CLI||local.cli||'',asar:process.env.COORDINATOR_DSH_ASAR||local.asar||'',node:process.execPath,backupRoot:path.join(root,'install-backups')};
const release = {
  schema: 1, name: pkg.name,canonicalName:pkg.dshCoordinator?.canonicalName??pkg.name, version: pkg.version, runtimeVersion: '0.2.0-rc.2',
  archive, sha256: sha256(contents.archive),
  files: Object.fromEntries([...contents.files].map(([name, bytes]) => [name, sha256(bytes)])),
  defaults,
  installation: {preferredTool: 'plugin_manager', action: 'install_bundle', target: archive, enabled: true, guide: path.join(root, 'AGENT_INSTALL.md')},
};
fs.writeFileSync(path.join(root, 'dist', 'agent-install.json'), JSON.stringify(release, null, 2) + '\n');
console.log(JSON.stringify({release: path.join(root, 'dist', 'agent-install.json'), sha256: release.sha256, files: contents.files.size}));
