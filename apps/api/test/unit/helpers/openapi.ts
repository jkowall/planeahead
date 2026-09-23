/**
 * A deliberately tiny reader for the two vendored OpenAPI YAML files, and a shape checker that
 * holds the fixtures to them. No YAML library (increment 6 ruling H8): the files use a narrow,
 * regular subset (block mappings, `- ` sequences, `|` block scalars, one-line quoted scalars), and
 * this reader handles exactly that subset. It builds an indentation tree of keys; it does not try
 * to be a YAML parser, and it throws on a line it cannot place rather than guessing.
 */

export interface YamlNode {
  /** The mapping key, or `-` for a sequence item. */
  readonly key: string;
  /** The inline scalar after `key:` (or after `- `), unquoted; undefined for a nested block. */
  value?: string;
  readonly indent: number;
  readonly children: YamlNode[];
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** `key: value`, `key:` or a bare scalar. Keys never contain `: `, values may. */
function splitEntry(content: string): { key: string | null; value: string | undefined } {
  if (content.endsWith(':') && !content.startsWith('"') && !content.startsWith("'")) {
    return { key: unquote(content.slice(0, -1)), value: undefined };
  }
  const quotedKey = /^('[^']*'|"[^"]*"):(?: (.*))?$/.exec(content);
  if (quotedKey?.[1] !== undefined) {
    return {
      key: unquote(quotedKey[1]),
      value: quotedKey[2] === undefined ? undefined : unquote(quotedKey[2]),
    };
  }
  const at = content.indexOf(': ');
  if (at > 0 && !content.startsWith('"') && !content.startsWith("'")) {
    return { key: content.slice(0, at), value: unquote(content.slice(at + 2)) };
  }
  return { key: null, value: unquote(content) };
}

const BLOCK_SCALAR = /^[|>][+-]?$/;

export function parseYamlTree(text: string): YamlNode {
  const root: YamlNode = { key: '', indent: -1, children: [] };
  /** Open containers; a sequence item opens one for its inline mapping at indent + 2. */
  const stack: YamlNode[] = [root];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    let content = raw.trim();
    while ((stack.at(-1)?.indent ?? -1) >= indent) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (parent === undefined) {
      throw new Error(`yaml: no parent for line ${String(index + 1)}`);
    }
    let owner = parent;
    let entryIndent = indent;
    if (content === '-' || content.startsWith('- ')) {
      const item: YamlNode = { key: '-', indent, children: [] };
      parent.children.push(item);
      stack.push(item);
      content = content === '-' ? '' : content.slice(2).trim();
      if (content === '') {
        continue;
      }
      owner = item;
      entryIndent = indent + 2;
    }
    const { key, value } = splitEntry(content);
    if (key === null) {
      // A scalar sequence item (`- in`).
      if (owner.key === '-' && owner.value === undefined && owner.children.length === 0) {
        owner.value = value ?? '';
        continue;
      }
      throw new Error(`yaml: bare scalar on line ${String(index + 1)}: ${content}`);
    }
    const node: YamlNode = { key, indent: entryIndent, children: [] };
    owner.children.push(node);
    if (value !== undefined && BLOCK_SCALAR.test(value)) {
      node.value = '';
      // Skip the block scalar's lines: everything indented deeper than the key.
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        if (next.trim() !== '' && next.length - next.trimStart().length <= entryIndent) {
          break;
        }
        index += 1;
      }
      continue;
    }
    if (value !== undefined) {
      node.value = value;
      continue;
    }
    stack.push(node);
  }
  return root;
}

/** Walks mapping keys, or sequence positions given as numbers. */
export function at(node: YamlNode | undefined, ...path: (string | number)[]): YamlNode | undefined {
  let current = node;
  for (const step of path) {
    if (current === undefined) {
      return undefined;
    }
    current =
      typeof step === 'number'
        ? current.children.filter((child) => child.key === '-')[step]
        : current.children.find((child) => child.key === step);
  }
  return current;
}

export function keysOf(node: YamlNode | undefined): string[] {
  return (node?.children ?? []).map((child) => child.key);
}

/** The scalar items of a sequence (`required`, `enum`). */
export function listOf(node: YamlNode | undefined): string[] {
  return (node?.children ?? [])
    .filter((child) => child.key === '-' && child.value !== undefined)
    .map((child) => child.value ?? '');
}

/** An OpenAPI document with `$ref` resolution against its own `components/schemas`. */
export class OpenApiDoc {
  readonly root: YamlNode;

  constructor(text: string) {
    this.root = parseYamlTree(text);
  }

  schema(name: string): YamlNode {
    const node = at(this.root, 'components', 'schemas', name);
    if (node === undefined) {
      throw new Error(`no schema ${name}`);
    }
    return node;
  }

  /** Follows `$ref` and flattens `allOf` into one `{ properties, required, ... }` view. */
  resolve(node: YamlNode): ResolvedSchema {
    const ref = at(node, '$ref')?.value;
    if (ref !== undefined) {
      const name = ref.replace('#/components/schemas/', '');
      return { ...this.resolve(this.schema(name)), nullable: isTrue(at(node, 'nullable')) };
    }
    const allOf = at(node, 'allOf');
    const merged: ResolvedSchema = {
      node,
      type: at(node, 'type')?.value,
      properties: new Map(),
      required: listOf(at(node, 'required')),
      enumValues: at(node, 'enum') === undefined ? null : listOf(at(node, 'enum')),
      items: at(node, 'items') ?? null,
      nullable: isTrue(at(node, 'nullable')),
    };
    for (const property of at(node, 'properties')?.children ?? []) {
      merged.properties.set(property.key, property);
    }
    for (const member of allOf?.children ?? []) {
      const resolved = this.resolve(member);
      for (const [key, value] of resolved.properties) {
        merged.properties.set(key, value);
      }
      merged.required.push(...resolved.required);
      merged.type ??= resolved.type;
      merged.enumValues ??= resolved.enumValues;
      merged.items ??= resolved.items;
    }
    return merged;
  }

  /**
   * Every way `value` departs from `node`: a key the schema does not declare, a required key
   * missing, a null where the schema is not nullable, a value outside an enum, a wrong JSON type.
   */
  violations(value: unknown, node: YamlNode, path = '$'): string[] {
    const schema = this.resolve(node);
    if (value === null) {
      return schema.nullable ? [] : [`${path}: null but not nullable`];
    }
    const errors: string[] = [];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (schema.enumValues !== null && !schema.enumValues.includes(text)) {
      errors.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enumValues.join('|')}`);
    }
    if (schema.properties.size > 0 || schema.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return [...errors, `${path}: expected an object`];
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const property = schema.properties.get(key);
        if (property === undefined) {
          errors.push(`${path}.${key}: not declared by the schema`);
          continue;
        }
        errors.push(...this.violations(record[key], property, `${path}.${key}`));
      }
      for (const key of schema.required) {
        if (!(key in record)) {
          errors.push(`${path}.${key}: required but missing`);
        }
      }
      return errors;
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) {
        return [...errors, `${path}: expected an array`];
      }
      if (schema.items !== null) {
        for (const [index, item] of value.entries()) {
          errors.push(...this.violations(item, schema.items, `${path}[${String(index)}]`));
        }
      }
      return errors;
    }
    const expected: Record<string, string> = {
      string: 'string',
      integer: 'number',
      number: 'number',
      boolean: 'boolean',
    };
    const wanted = schema.type === undefined ? undefined : expected[schema.type];
    if (wanted !== undefined && typeof value !== wanted) {
      errors.push(`${path}: expected ${schema.type ?? ''}, got ${typeof value}`);
    }
    if (schema.type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
      errors.push(`${path}: expected an integer`);
    }
    return errors;
  }
}

export interface ResolvedSchema {
  node: YamlNode;
  type: string | undefined;
  properties: Map<string, YamlNode>;
  required: string[];
  enumValues: string[] | null;
  items: YamlNode | null;
  nullable: boolean;
}

function isTrue(node: YamlNode | undefined): boolean {
  return node?.value === 'true';
}

/** Lower-case hex SHA-256 of a string's UTF-8 bytes. */
export async function sha256HexOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
