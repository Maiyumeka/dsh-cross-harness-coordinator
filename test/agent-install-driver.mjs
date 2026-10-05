import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const require=createRequire(import.meta.url);
const manager=require.resolve('@deepseek-ai/dsh-plugin-manager');
const {apply:register}=await import(pathToFileURL(path.join(path.dirname(manager),'types/tools.js')).href);
export const inject = ['pluginManager', 'connection', 'webServer', 'tools', 'agents'];
export function apply(ctx) {
  let tool;
  // Test the actual shipped Agent tool, with explicit test-only permission.
  // No model requests and no production profile are used.
  register({tools: {register(t) {tool = t;}}, pluginManager: ctx.pluginManager,
    sandboxPolicy: {resolve() {return {mode: 'danger-full-access'};}}, get() {return undefined;}});
  ctx.connection.register(ctx, '/agent-installer-test', async (method, payload, signal) => {
    if (method === 'probe') {
      const agent = ctx.agents.get(payload.sessionId);
      const names = ['coordinator_candidates', 'coordinator_status', 'coordinator_plan', 'coordinator_read', 'coordinator_review', 'coordinator_control', 'coordinator_wait'];
      const plugins = (await ctx.pluginManager.listPlugins()).filter(row => row.entryId === 'include:cross-harness-coordinator').map(({entryId, enabled, fiberPhase}) => ({entryId, enabled, fiberPhase}));
      return {ok: true, value: {tools: names.filter(name => ctx.tools.get(name, agent)), agentLoaded: !!agent, plugins}};
    }
    if (method !== 'execute') throw new Error('unknown method');
    return {ok: true, value: JSON.parse(await tool.execute(payload, {signal, callId: 'isolated-install-test'}))};
  });
}
