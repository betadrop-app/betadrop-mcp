/**
 * Apple's BOM ("bill of materials") container, the file format underneath a compiled asset
 * catalog (Assets.car). It is a block store: a header, an index of blocks (address and length),
 * a table of named variables pointing at blocks, and B+ trees whose leaves pair a key block with
 * a value block. Everything in the container itself is big-endian; what the blocks hold is the
 * catalog's business (little-endian, see assetsCar.ts).
 *
 * Only reading is needed, and only of trees: assetsCar.ts asks for FACETKEYS, APPEARANCEKEYS and
 * RENDITIONS by name and walks their leaves. Every address is checked against the file, and a
 * tree walk visits each block at most once, so a damaged or hostile file ends in a BomError, not
 * in a loop.
 */

export class BomError extends Error {}

export interface BomEntry {
  key: Uint8Array;
  value: Uint8Array;
}

export interface Bom {
  /** Variable name to block id (CARHEADER, RENDITIONS, FACETKEYS, …). */
  readonly vars: ReadonlyMap<string, number>;
  /** The block's bytes, or null when the id or its range is out of the file. */
  block(id: number): Uint8Array | null;
  /** Every leaf of the named tree, in key order; null when the variable does not exist. */
  tree(name: string, maxEntries?: number): BomEntry[] | null;
}

const MAX_TREE_ENTRIES = 2_000_000;

export function readBom(bytes: Uint8Array): Bom {
  if (bytes.length < 32 || String.fromCharCode(...Array.from(bytes.subarray(0, 8))) !== "BOMStore") {
    throw new BomError("not a BOM file");
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexAt = v.getUint32(16);
  const varsAt = v.getUint32(24);
  if (indexAt + 4 > bytes.length || varsAt + 4 > bytes.length) throw new BomError("BOM header out of range");

  const blockCount = v.getUint32(indexAt);
  if (indexAt + 4 + blockCount * 8 > bytes.length) throw new BomError("BOM block index out of range");

  const block = (id: number): Uint8Array | null => {
    if (!Number.isInteger(id) || id <= 0 || id >= blockCount) return null;
    const addr = v.getUint32(indexAt + 4 + id * 8);
    const len = v.getUint32(indexAt + 8 + id * 8);
    if (addr + len > bytes.length) return null;
    return bytes.subarray(addr, addr + len);
  };

  const vars = new Map<string, number>();
  const varCount = v.getUint32(varsAt);
  let p = varsAt + 4;
  for (let i = 0; i < varCount; i++) {
    if (p + 5 > bytes.length) throw new BomError("BOM variables out of range");
    const id = v.getUint32(p);
    const len = bytes[p + 4];
    if (p + 5 + len > bytes.length) throw new BomError("BOM variables out of range");
    vars.set(new TextDecoder("utf-8").decode(bytes.subarray(p + 5, p + 5 + len)), id);
    p += 5 + len;
  }

  const tree = (name: string, maxEntries = MAX_TREE_ENTRIES): BomEntry[] | null => {
    const id = vars.get(name);
    if (id === undefined) return null;
    const head = block(id);
    if (!head || head.length < 12 || String.fromCharCode(...Array.from(head.subarray(0, 4))) !== "tree") {
      throw new BomError(`${name} is not a BOM tree`);
    }
    const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const visited = new Set<number>();
    const paths = (pid: number): { b: Uint8Array; d: DataView; leaf: boolean; count: number } => {
      if (visited.has(pid)) throw new BomError(`${name} tree loops`);
      visited.add(pid);
      const b = block(pid);
      if (!b || b.length < 12) throw new BomError(`${name} tree node out of range`);
      const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const count = d.getUint16(2);
      if (12 + count * 8 > b.length) throw new BomError(`${name} tree node too short`);
      return { b, d, leaf: d.getUint16(0) !== 0, count };
    };

    // Down the leftmost edge to the first leaf; the leaves are linked by their forward pointers.
    let node = paths(hv.getUint32(8));
    while (!node.leaf) {
      if (node.count === 0) return [];
      node = paths(node.d.getUint32(12));
    }
    const out: BomEntry[] = [];
    for (;;) {
      for (let i = 0; i < node.count; i++) {
        const value = block(node.d.getUint32(12 + i * 8));
        const key = block(node.d.getUint32(16 + i * 8));
        if (!value || !key) throw new BomError(`${name} entry out of range`);
        out.push({ key, value });
        if (out.length > maxEntries) throw new BomError(`${name} has too many entries`);
      }
      const forward = node.d.getUint32(4);
      if (!forward) break;
      node = paths(forward);
      if (!node.leaf) throw new BomError(`${name} leaf chain is broken`);
    }
    return out;
  };

  return { vars, block, tree };
}
