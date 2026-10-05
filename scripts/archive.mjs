import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
// Inspect the release without extracting or executing package code.
export function packageFiles(file) {
  const archive = fs.readFileSync(file);
  const tar = gunzipSync(archive, {maxOutputLength: 16 * 1024 * 1024});
  const files = new Map();
  let extended = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString().split('\0')[0];
    const prefix = string(345, 155);
    let name = (prefix ? prefix + '/' : '') + string(0, 100);
    const size = Number.parseInt(string(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('invalid tar size');
    const type = string(156, 1);
    if (type === 'x') {
      const pax = tar.subarray(offset + 512, offset + 512 + size);
      extended = {};
      for (let cursor = 0; cursor < pax.length;) {
        const space = pax.indexOf(32, cursor), length = Number(pax.subarray(cursor, space).toString());
        if (space < cursor || !Number.isSafeInteger(length) || length <= space - cursor + 1 || cursor + length > pax.length) throw new Error('invalid pax header');
        const value = pax.subarray(space + 1, cursor + length - 1).toString(), equals = value.indexOf('=');
        if (equals < 1) throw new Error('invalid pax field');
        extended[value.slice(0, equals)] = value.slice(equals + 1);
        cursor += length;
      }
    } else if (type === '' || type === '0') {
      name = extended.path ?? name;
      if (extended.size !== undefined && Number(extended.size) !== size) throw new Error('unsupported pax size');
      if (!name.startsWith('package/') || name.includes('\\') || name.split('/').some(p => p === '..')) throw new Error('invalid package path');
      const relative = name.slice(8);
      if (files.has(relative)) throw new Error('duplicate package path');
      files.set(relative, tar.subarray(offset + 512, offset + 512 + size));
      extended = {};
    } else if (type !== '5') throw new Error('unsupported tar entry');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!files.has('package.json')) throw new Error('package manifest missing');
  return {archive, files, manifest: JSON.parse(files.get('package.json').toString())};
}
