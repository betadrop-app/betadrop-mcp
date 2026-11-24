/**
 * ELF program headers and Google's two ELF checks: PT_LOAD alignment and the GNU_RELRO end.
 *
 * Only the ELF header and the program header table are read (a few hundred bytes for a normal
 * library). ELF32 and ELF64, little and big endian. Addresses are kept as BigInt so the RELRO
 * arithmetic is exact for any 64-bit value.
 */

import { PAGE_16K } from "./types";
import type { ElfStatus, RelroStatus } from "./types";

export const PT_LOAD = 1;
export const PT_GNU_RELRO = 0x6474e552;

/** The program header table may not sit further into the file than this. Real ones are at byte 52 or 64. */
const MAX_HEADER_BYTES = 1024 * 1024;

export interface ProgramHeader {
  type: number;
  flags: number;
  offset: bigint;
  vaddr: bigint;
  filesz: bigint;
  memsz: bigint;
  align: bigint;
}

export interface ElfHeader {
  is64Bit: boolean;
  littleEndian: boolean;
  machine: number;
  phoff: number;
  phentsize: number;
  phnum: number;
}

export type ElfRead =
  | { kind: "not_elf" }
  /** ELF magic present, but the headers could not be read. `is64Bit` when EI_CLASS was. */
  | { kind: "unreadable"; is64Bit?: boolean; machine?: number }
  | { kind: "elf"; header: ElfHeader; phdrs: ProgramHeader[] };

export function hasElfMagic(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;
}

/** Parses the ELF header from at least its first 64 bytes; null when it is not a usable one. */
export function parseElfHeader(b: Uint8Array): ElfHeader | null {
  if (!hasElfMagic(b) || b.length < 6) return null;
  const cls = b[4];
  const data = b[5];
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2)) return null;
  const is64Bit = cls === 2;
  const le = data === 1;
  if (b.length < (is64Bit ? 64 : 52)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const machine = v.getUint16(18, le);
  let phoff: number;
  let phentsize: number;
  let phnum: number;
  if (is64Bit) {
    const off = v.getBigUint64(32, le);
    if (off > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    phoff = Number(off);
    phentsize = v.getUint16(54, le);
    phnum = v.getUint16(56, le);
  } else {
    phoff = v.getUint32(28, le);
    phentsize = v.getUint16(42, le);
    phnum = v.getUint16(44, le);
  }
  return { is64Bit, littleEndian: le, machine, phoff, phentsize, phnum };
}

/** Program headers from bytes that start at the file's byte 0 and cover the table. */
export function parseProgramHeaders(b: Uint8Array, h: ElfHeader): ProgramHeader[] | null {
  const min = h.is64Bit ? 56 : 32;
  if (h.phentsize < min && h.phnum > 0) return null;
  if (h.phoff + h.phnum * h.phentsize > b.length) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = h.littleEndian;
  const out: ProgramHeader[] = [];
  for (let i = 0; i < h.phnum; i++) {
    const p = h.phoff + i * h.phentsize;
    if (h.is64Bit) {
      out.push({
        type: v.getUint32(p, le),
        flags: v.getUint32(p + 4, le),
        offset: v.getBigUint64(p + 8, le),
        vaddr: v.getBigUint64(p + 16, le),
        filesz: v.getBigUint64(p + 32, le),
        memsz: v.getBigUint64(p + 40, le),
        align: v.getBigUint64(p + 48, le),
      });
    } else {
      out.push({
        type: v.getUint32(p, le),
        offset: BigInt(v.getUint32(p + 4, le)),
        vaddr: BigInt(v.getUint32(p + 8, le)),
        filesz: BigInt(v.getUint32(p + 16, le)),
        memsz: BigInt(v.getUint32(p + 20, le)),
        flags: v.getUint32(p + 24, le),
        align: BigInt(v.getUint32(p + 28, le)),
      });
    }
  }
  return out;
}

/**
 * Reads the headers through `ensure`, which returns at least the first n bytes of the file (fewer
 * when the file is shorter).
 */
export async function readElf(ensure: (n: number) => Promise<Uint8Array>): Promise<ElfRead> {
  const head = await ensure(64);
  if (!hasElfMagic(head)) return { kind: "not_elf" };
  const cls = head.length > 4 ? head[4] : 0;
  const partial = { kind: "unreadable" as const, ...(cls === 1 || cls === 2 ? { is64Bit: cls === 2 } : {}) };
  const header = parseElfHeader(head);
  if (!header) return partial;
  const withMachine = { ...partial, machine: header.machine };
  // PN_XNUM: the real count is in section header 0. No Android library needs it; reading the
  // section table for it is not worth the code, so such a file reads as unreadable.
  if (header.phnum === 0xffff) return withMachine;
  const need = header.phoff + header.phnum * header.phentsize;
  if (need > MAX_HEADER_BYTES) return withMachine;
  const bytes = need <= head.length ? head : await ensure(need);
  const phdrs = parseProgramHeaders(bytes, header);
  if (!phdrs) return withMachine;
  return { kind: "elf", header, phdrs };
}

const toNumber = (n: bigint): number => (n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n));

/**
 * Check 1. Google: "Check the output lines to ensure that the load segments don't have values
 * less than 2**14", i.e. every PT_LOAD's p_align must be at least 16384.
 *
 * Note: check_elf_alignment.sh looks only at the FIRST LOAD line (`head -1`); Google's page asks
 * for every load segment, and that stricter reading is the one used here.
 * An ELF file with no PT_LOAD at all: the sources are silent; check_elf_alignment.sh would print
 * UNALIGNED (its empty match fails the 2**14 regex), so it reads as unaligned with no minimum.
 *
 * Two hardenings against a header edited to pass the check while the layout stayed 4 KB:
 *   - a p_align that is not a power of two is unaligned (ELF requires a power of two; 0 and 1 mean
 *     "no alignment");
 *   - when every p_align is >= 16384, each LOAD's p_vaddr and p_offset must agree modulo 16384,
 *     or it cannot be mmapped on 16 KB pages; otherwise unaligned with `offsetMismatch: true`.
 *     A linker always writes them congruent modulo p_align, so a real 16 KB library passes.
 */
export function checkLoadAlignment(phdrs: ProgramHeader[]): { status: ElfStatus; minLoadAlign: number | null; offsetMismatch?: true } {
  const loads = phdrs.filter((p) => p.type === PT_LOAD);
  if (!loads.length) return { status: "unaligned", minLoadAlign: null };
  let min = loads[0].align;
  for (const l of loads) if (l.align < min) min = l.align;
  const page = BigInt(PAGE_16K);
  const powerOfTwo = (n: bigint) => n > BigInt(0) && (n & (n - BigInt(1))) === BigInt(0);
  const minLoadAlign = toNumber(min);
  if (min < page || !loads.every((l) => powerOfTwo(l.align))) return { status: "unaligned", minLoadAlign };
  if (loads.some((l) => l.vaddr % page !== l.offset % page)) return { status: "unaligned", minLoadAlign, offsetMismatch: true };
  return { status: "aligned", minLoadAlign };
}

export interface RelroCheck {
  status: RelroStatus;
  end?: number;
  loadEnd?: number;
}

/**
 * Check 4, Google's "Check the RELRO security flag". Compliant if any of:
 *   1. no GNU_RELRO segment;
 *   2. (RELRO.VirtAddr + RELRO.MemSiz) % 0x4000 == 0;
 *   3. no writable data follows GNU_RELRO (Google: "in the same LOAD segment").
 *
 * Condition 3 is read by the reason Google gives, which is how the Android linker behaves, not by
 * the equality its page prints (LOAD.VirtAddr + LOAD.MemSiz == RELRO.VirtAddr + RELRO.MemSiz).
 * bionic's linker/linker_phdr.cpp _phdr_table_set_gnu_relro_prot mprotects read-only from
 * page_start(p_vaddr) to page_end(p_vaddr + p_memsz), "every page touched by the segment". So on
 * a 16 KB device whatever is writable between the RELRO end and the next 16 KB boundary becomes
 * read-only, whichever LOAD it belongs to. The rule here:
 *   end % 0x4000 != 0, and some PT_LOAD with PF_W has a byte of [p_vaddr, p_vaddr + p_memsz)
 *   inside [end, roundUp(end, 0x4000))  =>  "misaligned"; otherwise "ok".
 * That covers Google's example 1 (the RELRO LOAD continues past the end), RELRO that ends inside
 * the next writable LOAD, and a second writable LOAD starting in the same 16 KB page. It gives
 * "ok" for the real NDK r25 / LLD 14 layout where RELRO ends past its own LOAD (llvm-readelf -Wl
 * of libandroidx.graphics.path.so, arm64, max-page-size 16384):
 *   LOAD      0x001c40 0x0000000000005c40 ... FileSiz 0x000390 MemSiz 0x000390 RW 0x4000  (ends 0x5fd0)
 *   LOAD      0x001fd0 0x0000000000009fd0 ... FileSiz 0x000000 MemSiz 0x000010 RW 0x4000  (.bss, next 16 KB page)
 *   GNU_RELRO 0x001c40 0x0000000000005c40 ... FileSiz 0x000390 MemSiz 0x0003c0 R  0x1     (ends 0x6000)
 *
 * `loadEnd` is the end of the PT_LOAD whose [VirtAddr, VirtAddr + MemSiz) holds RELRO's start,
 * when one does. With several GNU_RELRO segments (none seen in practice) the worst one wins.
 */
export function checkRelro(phdrs: ProgramHeader[]): RelroCheck {
  const relros = phdrs.filter((p) => p.type === PT_GNU_RELRO);
  if (!relros.length) return { status: "none" };
  const loads = phdrs.filter((p) => p.type === PT_LOAD);
  const page = BigInt(PAGE_16K);
  const PF_W = 2;
  let worst: RelroCheck | null = null;
  for (const r of relros) {
    const end = r.vaddr + r.memsz;
    const load = loads.find((l) => l.vaddr <= r.vaddr && r.vaddr < l.vaddr + l.memsz);
    const loadEnd = load ? load.vaddr + load.memsz : undefined;
    let status: RelroStatus = "ok";
    if (end % page !== BigInt(0)) {
      const pageEnd = end - (end % page) + page;
      const writableAfter = loads.some((l) => (l.flags & PF_W) !== 0 && l.memsz > BigInt(0) && l.vaddr < pageEnd && l.vaddr + l.memsz > end);
      if (writableAfter) status = "misaligned";
    }
    const c: RelroCheck = { status, end: toNumber(end), ...(loadEnd !== undefined ? { loadEnd: toNumber(loadEnd) } : {}) };
    if (!worst || (c.status === "misaligned" && worst.status !== "misaligned")) worst = c;
  }
  return worst!;
}

/** The ABI an ELF header implies, for a bare .so. */
export function abiOfMachine(machine: number, is64Bit: boolean): string | null {
  if (machine === 183 && is64Bit) return "arm64-v8a";
  if (machine === 62 && is64Bit) return "x86_64";
  if (machine === 40 && !is64Bit) return "armeabi-v7a";
  if (machine === 3 && !is64Bit) return "x86";
  if (machine === 243 && is64Bit) return "riscv64";
  return null;
}
