/**
 * A readable snapshot of a rendered screen: every host element's type, its test id and
 * accessibility label, its text, and the colour tokens its flattened style carries (the part of a
 * style that differs between the light and the dark theme). The raw renderer tree is an order of
 * magnitude larger (every layout number, every handler) and hides the theme in noise.
 */

import { StyleSheet } from 'react-native';

interface JsonNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly (JsonNode | string)[] | null;
}

const COLOR_KEYS = ['backgroundColor', 'color', 'borderColor', 'borderLeftColor'] as const;

function colors(style: unknown): Record<string, unknown> | undefined {
  const flattened: unknown = StyleSheet.flatten(style);
  if (typeof flattened !== 'object' || flattened === null) {
    return undefined;
  }
  const flat = flattened as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of COLOR_KEYS) {
    if (flat[key] !== undefined && flat[key] !== 'transparent') {
      picked[key] = flat[key];
    }
  }
  if (flat['textDecorationLine'] !== undefined) {
    picked['textDecorationLine'] = flat['textDecorationLine'];
  }
  return Object.keys(picked).length === 0 ? undefined : picked;
}

function compactNode(node: JsonNode | string): unknown {
  if (typeof node === 'string') {
    return node;
  }
  const out: Record<string, unknown> = { type: node.type };
  const { testID, accessibilityLabel, style } = node.props;
  if (typeof testID === 'string') {
    out['testID'] = testID;
  }
  if (typeof accessibilityLabel === 'string') {
    out['label'] = accessibilityLabel;
  }
  const picked = colors(style);
  if (picked !== undefined) {
    out['style'] = picked;
  }
  const children = (node.children ?? []).map(compactNode);
  if (children.length > 0) {
    out['children'] = children;
  }
  return out;
}

export function compactTree(json: unknown): unknown {
  if (json === null) {
    return null;
  }
  if (Array.isArray(json)) {
    return json.map((node) => compactNode(node as JsonNode));
  }
  return compactNode(json as JsonNode);
}
