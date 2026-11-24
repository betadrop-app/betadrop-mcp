/**
 * Re-reads a finished export before it is handed over: every file the plan promised is there,
 * every PNG's header says the size and colour type it should and the file ends properly, no image
 * that must show something came out blank, and every reference between files holds —
 * Contents.json → images, adaptive-icon XML → mipmaps and colours, the web manifest and the
 * head snippet → icons, Expo's app.json → assets.
 *
 * Most of this cannot fail while the plan, the renderer and the encoder agree (the plan is tested
 * and compiled with actool and aapt2 by `npm run verify:app-icons`); it is the same promise made
 * visible for the one zip being downloaded. The blank-image test is the one that catches a real
 * runtime fault: an image that failed to draw still encodes to a valid, empty PNG.
 *
 * Pure: it takes the bytes, so the tests run it on exports built in Node.
 */

import { readIco } from "./ico";
import type { PlanItem } from "./plan";
import { readPngChunks, readPngHeader } from "./png";

export interface ExportVerification {
  /** Planned files examined (the README, written afterwards, is not one of them). */
  checked: number;
  /** Plain-English problems; empty when everything holds. */
  problems: string[];
}

const decoder = new TextDecoder();

/**
 * `blank` lists the paths whose image was drawn with no visible pixel; the renderer knows that,
 * the bytes alone (deflated pixels) don't say it cheaply.
 */
export function verifyExport(
  files: ReadonlyMap<string, Uint8Array>,
  items: readonly PlanItem[],
  blank: readonly string[] = [],
): ExportVerification {
  const problems: string[] = blank.map((path) => `${path} came out blank`);
  let checked = 0;
  const text = (path: string) => {
    const bytes = files.get(path);
    return bytes ? decoder.decode(bytes) : null;
  };
  const pngSize = (path: string) => {
    const bytes = files.get(path);
    return bytes ? readPngHeader(bytes) : null;
  };

  // 1. Every planned file exists, and each image is what the plan asked for.
  for (const item of items) {
    const bytes = files.get(item.path);
    if (!bytes) {
      problems.push(`${item.path} is missing`);
      continue;
    }
    checked++;
    if (item.type === "png") {
      const h = readPngHeader(bytes);
      const chunks = readPngChunks(bytes, false);
      const want = item.encoding === "rgb" ? 2 : 6;
      if (!h) problems.push(`${item.path} is not a readable PNG`);
      else if (h.width !== item.px || h.height !== item.px) problems.push(`${item.path} is ${h.width}×${h.height}, expected ${item.px}×${item.px}`);
      else if (h.colorType !== want || h.bitDepth !== 8) {
        problems.push(`${item.path} has PNG colour type ${h.colorType}, expected ${want}${want === 2 ? " (no alpha channel)" : ""}`);
      } else if (chunks[chunks.length - 1]?.type !== "IEND") problems.push(`${item.path} is truncated`);
    } else if (item.type === "svg") {
      const svg = decoder.decode(bytes);
      if (!/^<svg[\s>]/.test(svg) || !svg.trimEnd().endsWith("</svg>")) problems.push(`${item.path} is not a complete SVG`);
    } else if (item.type === "ico") {
      const entries = readIco(bytes);
      const sizes = entries.map((e) => e.size);
      if (sizes.join() !== item.sizes.join()) problems.push(`${item.path} holds ${sizes.join(", ") || "nothing"}, expected ${item.sizes.join(", ")}`);
      for (const e of entries) {
        const h = readPngHeader(e.data);
        if (!h || h.width !== e.size || h.height !== e.size) problems.push(`${item.path}: the ${e.size} px image is not a ${e.size} px PNG`);
      }
    }
  }

  // 2. Asset catalogs: every image named in Contents.json exists at points × scale.
  for (const item of items) {
    if (!item.path.endsWith(".appiconset/Contents.json")) continue;
    const dir = item.path.slice(0, -"/Contents.json".length);
    const raw = text(item.path);
    let images: { filename?: string; size?: string; scale?: string }[] = [];
    try {
      images = (JSON.parse(raw ?? "") as { images?: typeof images }).images ?? [];
    } catch {
      problems.push(`${item.path} is not valid JSON`);
      continue;
    }
    const listed = new Set<string>();
    for (const img of images) {
      if (!img.filename) continue;
      listed.add(img.filename);
      const h = pngSize(`${dir}/${img.filename}`);
      const pt = Number((img.size ?? "").split("x")[0]);
      const scale = img.scale ? Number(img.scale.replace("x", "")) : 1;
      if (!h) problems.push(`${dir}/Contents.json lists ${img.filename}, which is not in the zip`);
      else if (h.width !== Math.round(pt * scale)) problems.push(`${dir}/${img.filename} is ${h.width} px, Contents.json says ${Math.round(pt * scale)}`);
    }
    for (const path of Array.from(files.keys())) {
      if (path.startsWith(`${dir}/`) && path.endsWith(".png") && !listed.has(path.slice(dir.length + 1))) {
        problems.push(`${path} is not listed in Contents.json (Xcode would warn about an unassigned image)`);
      }
    }
  }

  // 3. Android: each adaptive-icon reference resolves at every density it needs.
  for (const item of items) {
    const m = /^(.*\/res)\/mipmap-anydpi-v26\/[^/]+\.xml$/.exec(item.path);
    if (!m) continue;
    const res = m[1];
    const xml = text(item.path) ?? "";
    const densities = Array.from(new Set(Array.from(files.keys()).map((p) => new RegExp(`^${escapeRe(res)}/mipmap-(\\w+dpi)/`).exec(p)?.[1]).filter((d): d is string => Boolean(d) && d !== "anydpi")));
    for (const ref of Array.from(xml.matchAll(/@(mipmap|color)\/(\w+)/g))) {
      const [, kind, name] = ref;
      if (kind === "mipmap") {
        for (const d of densities) {
          if (!files.has(`${res}/mipmap-${d}/${name}.png`)) problems.push(`${item.path} uses @mipmap/${name}, missing at ${d}`);
        }
      } else {
        const defined = Array.from(files.keys()).some(
          (p) => p.startsWith(`${res}/values/`) && new RegExp(`<color name="${name}">`).test(text(p) ?? ""),
        );
        if (!defined) problems.push(`${item.path} uses @color/${name}, which no values file defines`);
      }
    }
  }

  // 4. The web manifest and Expo's app.json parse, and point at files that exist.
  for (const item of items) {
    if (item.path.endsWith("site.webmanifest")) {
      try {
        const manifest = JSON.parse(text(item.path) ?? "") as { icons?: { src: string; sizes: string }[] };
        const dir = item.path.slice(0, item.path.lastIndexOf("/"));
        for (const icon of manifest.icons ?? []) {
          const h = pngSize(`${dir}/${icon.src.replace(/^\//, "")}`);
          const px = Number(icon.sizes.split("x")[0]);
          if (!h) problems.push(`site.webmanifest lists ${icon.src}, which is not in the zip`);
          else if (h.width !== px) problems.push(`site.webmanifest says ${icon.src} is ${px} px, it is ${h.width}`);
        }
      } catch {
        problems.push(`${item.path} is not valid JSON`);
      }
    }
    if (item.path.endsWith("head-snippet.html")) {
      // Every file the <head> tags link to sits beside the snippet in the zip.
      const dir = item.path.slice(0, item.path.lastIndexOf("/"));
      for (const ref of Array.from((text(item.path) ?? "").matchAll(/href="\/([^"]+)"/g))) {
        if (!files.has(`${dir}/${ref[1]}`)) problems.push(`head-snippet.html links /${ref[1]}, which is not in the zip`);
      }
    }
    if (item.path.endsWith("snippets/app.json")) {
      try {
        const raw = text(item.path) ?? "";
        JSON.parse(raw);
        for (const ref of Array.from(raw.matchAll(/"\.\/([^"]+\.png)"/g))) {
          if (!files.has(ref[1])) problems.push(`app.json points at ${ref[1]}, which is not in the zip`);
        }
      } catch {
        problems.push(`${item.path} is not valid JSON`);
      }
    }
  }

  return { checked, problems };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
