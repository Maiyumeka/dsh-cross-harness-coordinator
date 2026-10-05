import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const dshCli=process.env.COORDINATOR_DSH_CLI||require.resolve('@deepseek-ai/dsh');
const {runCli}=await import(pathToFileURL(dshCli).href);

const home = path.resolve(process.env.COORDINATOR_TEST_HOME ?? 'test-data/agent-install-home');
process.env.DSH_HOME = home;
const profile = path.join(home, 'profiles', 'web');
fs.mkdirSync(profile, {recursive: true});
if (!fs.existsSync(path.join(profile, 'package.json'))) {
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({name: 'dsh-profile-web', private: true, dependencies: {}, dsh: {profile: {bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']}}}, null, 2));
  fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
}
fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), `- id: session-telemetry-otel\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n- insert:\n    - id: agent-installer-test-driver\n      name: ${path.resolve('test/agent-install-driver.mjs').replaceAll('\\', '/')}\n`);
process.argv = [process.execPath, 'dsh', '--profile', 'web', '--host', '127.0.0.1', '--port', '19426', '--no-open'];
await runCli({packageManager: {command: process.execPath, args: [process.env.COORDINATOR_PNPM_CLI||require.resolve('pnpm/bin/pnpm.cjs')], env: {XDG_CONFIG_HOME: path.join(home, 'pnpm-config'), XDG_DATA_HOME: path.join(home, 'pnpm-data'), XDG_CACHE_HOME: path.join(home, 'pnpm-cache')}}});
