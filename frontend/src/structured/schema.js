// Per-call schema specialisation. The registry schemas declare `source` as a free string;
// left that way, small models wrote values like "S6.17.4" or "S7. 1 The Supplier shall…"
// (label blended with section numbers and text). Restricting `source` to an enum of this
// call's actual labels makes an invalid citation impossible at the grammar level.

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * @param {object} schema  registry schema
 * @param {string[]} path  property path to the `source` field's parent object, e.g. ["items", "items"]
 * @param {string[]} labels  allowed source labels for this call
 */
export function withSourceEnum(schema, path, labels) {
  const out = clone(schema);
  let node = out;
  for (const key of path) node = key === "items" && node.type === "array" ? node.items : node.properties[key];
  node.properties.source = { ...node.properties.source, enum: [...labels] };
  return out;
}
