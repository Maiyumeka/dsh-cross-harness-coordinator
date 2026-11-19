const number = '(?:0|[1-9][0-9]*)';
const identifier = '[0-9A-Za-z-]+';
const versionPattern = new RegExp(
  `^(${number})\\.(${number})\\.(${number})(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+${identifier}(?:\\.${identifier})*)?$`,
);

function parseVersion(value) {
  const match = typeof value === 'string' && versionPattern.exec(value);
  if (!match) throw new Error(`invalid DSH version: ${String(value)}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(id => /^0[0-9]+$/.test(id))) {
    throw new Error(`invalid DSH version: ${value}`);
  }
  return {core: match.slice(1, 4).map(BigInt), prerelease};
}

function compare(a, b) {
  for (let i = 0; i < a.core.length; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  const left = a.prerelease, right = b.prerelease;
  if (!left.length || !right.length) return Number(right.length > 0) - Number(left.length > 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue;
    const leftNumeric = /^[0-9]+$/.test(left[i]);
    const rightNumeric = /^[0-9]+$/.test(right[i]);
    if (leftNumeric && rightNumeric) return BigInt(left[i]) < BigInt(right[i]) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[i] < right[i] ? -1 : 1;
  }
  return Math.sign(left.length - right.length);
}

// Coordinator packages declare an inclusive lower and exclusive upper bound.
// Like DSH's includePrerelease setting, this includes RCs between the bounds.
export function assertHostCompatibility(hostVersion, manifest, testedVersion) {
  const host = parseVersion(hostVersion);
  const tested = parseVersion(testedVersion);
  const range = manifest.engines?.dsh;
  if (range === undefined) {
    // Packages predating engines.dsh keep their original exact-version rule.
    if (hostVersion === testedVersion) return;
    throw new Error(`runtime mismatch: desktop ${hostVersion}, expected ${testedVersion}`);
  }
  const bounds = typeof range === 'string' && /^>=([^\s]+)\s+<([^\s]+)$/.exec(range);
  if (!bounds) throw new Error(`unsupported DSH compatibility range: ${String(range)}`);
  const lower = parseVersion(bounds[1]), upper = parseVersion(bounds[2]);
  const accepts = version => compare(version, lower) >= 0 && compare(version, upper) < 0;
  if (!accepts(tested)) throw new Error(`tested DSH version ${testedVersion} is outside compatibility range ${range}`);
  if (!accepts(host)) throw new Error(`runtime mismatch: desktop ${hostVersion}, required ${range}`);
}
