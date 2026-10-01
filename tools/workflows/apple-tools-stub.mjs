/**
 * Stand-ins for the Apple tools scripts/native-smoke.sh's iOS checks run (increment 13 review,
 * ruling F2), so tools/workflows/native-smoke.test.js runs those checks on its Linux runner:
 * `plutil`, `PlistBuddy`, `nm` and `vtool`, each as much of it as the script uses, with the real
 * tool's output and exit status for the same input. The darwin-only cases in that test run the
 * real plutil, PlistBuddy and nm on the same fixtures, which is what keeps these honest.
 *
 * Property lists are XML, which is what Xcode writes and the fixtures use. A fake executable is a
 * text file (`fakeExecutable` below): `FAKE-MACH-O`, then `@platform <LC_BUILD_VERSION platform>`,
 * then its undefined symbols one a line, grouped under `@arch <name>` lines for a universal
 * binary. Like the real nm on an Apple silicon Mac, the nm here reads only the arm64 slice of a
 * universal binary unless it is given `-arch all`.
 *
 *   node apple-tools-stub.mjs <plutil | PlistBuddy | nm | vtool> [the tool's arguments]
 *
 * The module also exports the helpers the test builds its fixtures with.
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

class PlistError extends Error {}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(text) {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Parses an XML property list; dictionaries become Maps, so key order survives a rewrite. */
export function parsePlist(text) {
  let at = 0;
  const fail = (what) => {
    throw new PlistError(`${what} at offset ${at}`);
  };
  const take = (pattern) => {
    const space = /\s*/y;
    space.lastIndex = at;
    space.exec(text);
    pattern.lastIndex = space.lastIndex;
    const match = pattern.exec(text);
    if (match !== null) {
      at = pattern.lastIndex;
    }
    return match;
  };
  const value = () => {
    if (take(/<dict\/>/y)) return new Map();
    if (take(/<dict>/y)) {
      const dict = new Map();
      while (!take(/<\/dict>/y)) {
        const key = take(/<key>([^<]*)<\/key>/y) ?? fail('expected <key> or </dict>');
        dict.set(unescapeXml(key[1]), value());
      }
      return dict;
    }
    if (take(/<array\/>/y)) return [];
    if (take(/<array>/y)) {
      const array = [];
      while (!take(/<\/array>/y)) array.push(value());
      return array;
    }
    if (take(/<string\/>/y)) return '';
    const string = take(/<string>([^<]*)<\/string>/y);
    if (string) return unescapeXml(string[1]);
    const integer = take(/<integer>\s*(-?\d+)\s*<\/integer>/y);
    if (integer) return BigInt(integer[1]);
    const real = take(/<real>\s*([-+.\deE]+)\s*<\/real>/y);
    if (real) return Number(real[1]);
    if (take(/<true\/>/y)) return true;
    if (take(/<false\/>/y)) return false;
    const date = take(/<date>([^<]*)<\/date>/y);
    if (date) return new Date(date[1]);
    return fail('expected a property list value');
  };
  take(/<\?xml[^>]*\?>/y);
  take(/<!DOCTYPE[^>]*>/y);
  if (take(/<plist(?:\s[^>]*)?>/y) === null) fail('expected <plist>');
  const root = value();
  if (take(/<\/plist>/y) === null) fail('expected </plist>');
  take(/\s*/y);
  if (at !== text.length) fail('unexpected content after </plist>');
  return root;
}

/** An XML property list of `value`: objects and Maps are dictionaries, in their key order. */
export function plistXml(value) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ];
  const write = (node, indent) => {
    const entries = node instanceof Map ? [...node] : null;
    if (typeof node === 'string') lines.push(`${indent}<string>${escapeXml(node)}</string>`);
    else if (typeof node === 'boolean') lines.push(`${indent}<${String(node)}/>`);
    else if (typeof node === 'bigint') lines.push(`${indent}<integer>${String(node)}</integer>`);
    else if (typeof node === 'number') {
      lines.push(
        Number.isInteger(node)
          ? `${indent}<integer>${String(node)}</integer>`
          : `${indent}<real>${String(node)}</real>`,
      );
    } else if (Array.isArray(node)) {
      if (node.length === 0) lines.push(`${indent}<array/>`);
      else {
        lines.push(`${indent}<array>`);
        for (const item of node) write(item, `${indent}\t`);
        lines.push(`${indent}</array>`);
      }
    } else {
      const pairs = entries ?? Object.entries(node);
      if (pairs.length === 0) lines.push(`${indent}<dict/>`);
      else {
        lines.push(`${indent}<dict>`);
        for (const [key, item] of pairs) {
          lines.push(`${indent}\t<key>${escapeXml(key)}</key>`);
          write(item, `${indent}\t`);
        }
        lines.push(`${indent}</dict>`);
      }
    }
  };
  write(value, '');
  lines.push('</plist>', '');
  return lines.join('\n');
}

/**
 * A fake executable for the nm and vtool here: `symbols` is a list (a thin binary) or an object
 * of lists by architecture (a universal one, its first architecture first).
 */
export function fakeExecutable(platform, symbols) {
  const slices = Array.isArray(symbols)
    ? symbols
    : Object.entries(symbols).flatMap(([arch, names]) => [`@arch ${arch}`, ...names]);
  return ['FAKE-MACH-O', `@platform ${platform}`, ...slices, ''].join('\n');
}

function readExecutable(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (lines[0] !== 'FAKE-MACH-O') return null;
  let platform = null;
  const slices = [];
  let thin = { arch: null, symbols: [] };
  for (const line of lines.slice(1)) {
    if (line.startsWith('@platform ')) platform = line.slice('@platform '.length);
    else if (line.startsWith('@arch ')) {
      thin = null;
      slices.push({ arch: line.slice('@arch '.length), symbols: [] });
    } else if (line !== '') (thin ?? slices.at(-1)).symbols.push(line);
  }
  return { platform, universal: thin === null, slices: thin === null ? slices : [thin] };
}

/** plutil key paths are dotted; PlistBuddy's are colon separated. Numbers index arrays. */
function lookup(root, components) {
  let node = root;
  for (const component of components) {
    if (node instanceof Map && node.has(component)) node = node.get(component);
    else if (Array.isArray(node) && /^\d+$/.test(component) && Number(component) < node.length) {
      node = node[Number(component)];
    } else return undefined;
  }
  return node;
}

function typeOf(node) {
  if (typeof node === 'string') return 'string';
  if (typeof node === 'boolean') return 'bool';
  if (typeof node === 'bigint') return 'integer';
  if (typeof node === 'number') return 'float';
  if (node instanceof Date) return 'date';
  if (Array.isArray(node)) return 'array';
  return 'dictionary';
}

function readPlist(file) {
  return parsePlist(readFileSync(file, 'utf8'));
}

function plutil(args, out, err) {
  if (args[0] === '-lint') {
    const silent = args.includes('-s');
    let status = 0;
    for (const file of args.slice(1).filter((arg) => arg !== '-s')) {
      try {
        readPlist(file);
        if (!silent) out(`${file}: OK\n`);
      } catch (error) {
        err(`${file}: (${error.message})\n`);
        status = 1;
      }
    }
    return status;
  }
  if (args[0] === '-extract') {
    const [, keyPath, format, ...rest] = args;
    if (format !== 'raw') {
      err(`plutil stand-in: only the raw format is implemented, not ${format}\n`);
      return 2;
    }
    let expect = null;
    let newline = true;
    let output = null;
    const files = [];
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '-expect') expect = rest[(index += 1)];
      else if (rest[index] === '-n') newline = false;
      else if (rest[index] === '-o') output = rest[(index += 1)];
      else files.push(rest[index]);
    }
    if (output !== '-' || files.length !== 1) {
      err('plutil stand-in: -extract needs -o - and one file\n');
      return 2;
    }
    const [file] = files;
    let root;
    try {
      root = readPlist(file);
    } catch (error) {
      err(`${file}: Property List error: ${error.message}\n`);
      return 1;
    }
    const node = lookup(root, keyPath.split('.'));
    if (node === undefined) {
      err(
        `${file}: Could not extract value, error: No value at that key path or invalid key path: ${keyPath}\n`,
      );
      return 1;
    }
    if (expect !== null && typeOf(node) !== expect) {
      err(`${file}: Value at [${keyPath}] expected to be ${expect} but is ${typeOf(node)}\n`);
      return 1;
    }
    let text;
    if (Array.isArray(node)) text = String(node.length);
    else if (node instanceof Map) text = [...node.keys()].sort().join('\n');
    else if (node instanceof Date) text = node.toISOString().replace(/\.\d{3}Z$/, 'Z');
    else text = String(node);
    out(newline ? `${text}\n` : text);
    return 0;
  }
  err(`plutil stand-in: ${args[0] ?? '(nothing)'} is not implemented\n`);
  return 2;
}

function plistBuddyPrint(node, indent = '') {
  if (Array.isArray(node)) {
    const items = node.map((item) => `${indent}    ${plistBuddyPrint(item, `${indent}    `)}`);
    return ['Array {', ...items, `${indent}}`].join('\n');
  }
  if (node instanceof Map) {
    const items = [...node].map(
      ([key, item]) => `${indent}    ${key} = ${plistBuddyPrint(item, `${indent}    `)}`,
    );
    return ['Dict {', ...items, `${indent}}`].join('\n');
  }
  return String(node);
}

function plistBuddy(args, out, err) {
  if (args[0] !== '-c' || args.length !== 3) {
    err('PlistBuddy stand-in: expected -c "<command>" <file>\n');
    return 2;
  }
  const [, command, file] = args;
  const [verb, entry = '', ...value] = command.split(' ');
  let root;
  try {
    root = readPlist(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      out(`File Doesn't Exist, Will Create: ${file}\n`);
      err(`${verb}: Entry, "${entry}", Does Not Exist\n`);
    } else {
      // PlistBuddy names an unreadable file by its resolved path when it was given an absolute one.
      err(`${error.message}\n`);
      out(`Error Reading File: ${isAbsolute(file) ? realpathSync(file) : file}\n`);
    }
    return 1;
  }
  const components = entry.replace(/^:/, '').split(':');
  const node = lookup(root, components);
  if (node === undefined) {
    err(`${verb}: Entry, "${entry}", Does Not Exist\n`);
    return 1;
  }
  if (verb === 'Print') {
    out(`${plistBuddyPrint(node)}\n`);
    return 0;
  }
  if (verb === 'Set' && typeof node === 'string') {
    const parent = lookup(root, components.slice(0, -1));
    const key = components.at(-1);
    if (Array.isArray(parent)) parent[Number(key)] = value.join(' ');
    else parent.set(key, value.join(' '));
    writeFileSync(file, plistXml(root));
    return 0;
  }
  err(`PlistBuddy stand-in: ${command} is not implemented\n`);
  return 2;
}

function nm(args, out, err) {
  let undefinedOnly = false;
  let namesOnly = false;
  let arch = null;
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-u') undefinedOnly = true;
    else if (arg === '-j') namesOnly = true;
    else if (arg === '-arch') arch = args[(index += 1)];
    else if (arg.startsWith('-')) {
      err(`nm: error: unknown argument '${arg}'\n`);
      return 1;
    } else files.push(arg);
  }
  let status = 0;
  for (const file of files) {
    const executable = readExecutable(file);
    if (executable === null) {
      err(`nm: error: ${file}: The file was not recognized as a valid object file\n`);
      status = 1;
      continue;
    }
    let slices = executable.slices;
    if (executable.universal && arch !== 'all') {
      const wanted = arch ?? 'arm64';
      slices = slices.filter((slice) => slice.arch === wanted);
      if (slices.length === 0 && arch === null) slices = [executable.slices[0]];
      if (slices.length === 0) {
        err(`nm: error: ${file}: does not contain architecture ${arch}\n`);
        status = 1;
        continue;
      }
    }
    // -u prints names alone (Apple's nm does, -j or not); without either, nm's usual columns.
    const line = (symbol) =>
      namesOnly || undefinedOnly ? `${symbol}\n` : `                 U ${symbol}\n`;
    for (const slice of slices) {
      if (executable.universal && arch === 'all') {
        out(`\n${file} (for architecture ${slice.arch}):\n`);
      }
      for (const symbol of slice.symbols) out(line(symbol));
    }
  }
  return status;
}

function vtool(args, out, err) {
  if (args[0] !== '-show-build' || args.length !== 2) {
    err('vtool stand-in: expected -show-build <file>\n');
    return 2;
  }
  const file = args[1];
  const executable = readExecutable(file);
  if (executable === null) {
    err(`vtool error: ${file}: not a Mach-O file\n`);
    return 1;
  }
  for (const slice of executable.slices) {
    out(executable.universal ? `${file} (architecture ${slice.arch}):\n` : `${file}:\n`);
    if (executable.platform !== null) {
      out(
        [
          'Load command 10',
          '      cmd LC_BUILD_VERSION',
          '  cmdsize 32',
          ` platform ${executable.platform}`,
          '    minos 17.0',
          '      sdk 26.5',
          '   ntools 1',
          '     tool LD',
          '  version 1167.5',
          '',
        ].join('\n'),
      );
    }
  }
  return 0;
}

const TOOLS = { plutil, PlistBuddy: plistBuddy, nm, vtool };

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const [tool, ...args] = process.argv.slice(2);
  const run = TOOLS[tool];
  if (run === undefined) {
    process.stderr.write(`apple-tools-stub: no tool ${tool}\n`);
    process.exitCode = 2;
  } else {
    let stdout = '';
    let stderr = '';
    process.exitCode = run(
      args,
      (text) => (stdout += text),
      (text) => (stderr += text),
    );
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
}
