// Minimal Mongo-compatible query/update subset used by the in-memory adapter.
// Supported filter operators: equality (incl. "array contains"), $ne, $gt, $gte, $lt, $lte, $in, $exists, dotted paths.
// Supported updates: $set, $inc, $push (with optional $each/$slice), $unset, $setOnInsert.

export const clone = (v) => structuredClone(v);

function get(doc, path) {
  let cur = doc;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(doc, path, value) {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts.at(-1)] = value;
}

function unsetPath(doc, path) {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[parts[i]];
    if (cur == null) return;
  }
  delete cur[parts.at(-1)];
}

const cmp = (a, b) => (a instanceof Date ? a.getTime() : a) - (b instanceof Date ? b.getTime() : b);
const eq = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

function matchValue(value, cond) {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      switch (op) {
        case '$ne': if (Array.isArray(value) ? value.includes(arg) : eq(value, arg)) return false; break;
        case '$gt': if (!(value != null && cmp(value, arg) > 0)) return false; break;
        case '$gte': if (!(value != null && cmp(value, arg) >= 0)) return false; break;
        case '$lt': if (!(value != null && cmp(value, arg) < 0)) return false; break;
        case '$lte': if (!(value != null && cmp(value, arg) <= 0)) return false; break;
        case '$in': if (!arg.some((a) => (Array.isArray(value) ? value.includes(a) : eq(value, a)))) return false; break;
        case '$exists': if ((value !== undefined) !== !!arg) return false; break;
        default: throw new Error(`unsupported operator ${op}`);
      }
    }
    return true;
  }
  if (Array.isArray(value) && !Array.isArray(cond)) return value.some((v) => eq(v, cond));
  return eq(value, cond);
}

export function matches(doc, filter) {
  for (const [path, cond] of Object.entries(filter)) if (!matchValue(get(doc, path), cond)) return false;
  return true;
}

export function applyUpdate(doc, update, inserting) {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, v] of Object.entries(fields)) {
      switch (op) {
        case '$set': setPath(doc, path, clone(v)); break;
        case '$setOnInsert': if (inserting) setPath(doc, path, clone(v)); break;
        case '$inc': setPath(doc, path, (get(doc, path) || 0) + v); break;
        case '$unset': unsetPath(doc, path); break;
        case '$push': {
          const arr = get(doc, path) || [];
          if (v && typeof v === 'object' && '$each' in v) {
            arr.push(...clone(v.$each));
            if (v.$slice !== undefined) arr.splice(0, Math.max(0, arr.length - Math.abs(v.$slice)));
          } else arr.push(clone(v));
          setPath(doc, path, arr);
          break;
        }
        default: throw new Error(`unsupported update ${op}`);
      }
    }
  }
  return doc;
}

export function sortDocs(docs, sort) {
  const keys = Object.entries(sort);
  return docs.sort((a, b) => {
    for (const [k, dir] of keys) {
      const va = get(a, k), vb = get(b, k);
      if (va === vb) continue;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      return (va < vb ? -1 : 1) * dir;
    }
    return 0;
  });
}
