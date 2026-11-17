import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Keep probes on a copied runtime without changing shared node_modules or the host.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/') && process.env.COORDINATOR_HOST_RUNTIME) {
    const anchor = pathToFileURL(path.join(process.env.COORDINATOR_HOST_RUNTIME, 'probe.mjs'));
    return nextResolve(specifier, {...context, parentURL: anchor.href});
  }
  return nextResolve(specifier, context);
}
