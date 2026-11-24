/**
 * Manifest edits for a universal APK built from an .aab base module, and the
 * facts the converter needs from it. The edits are the ones bundletool makes
 * when it fuses a bundle into one standalone APK: split-only attributes and
 * the split meta-data go, the distribution namespace goes, and
 * extractNativeLibs follows how the native libraries are stored.
 */

import { ANDROID_NS, DIST_NS } from "./axml";
import type { XAttribute, XElement } from "./axml";
import { ResourcesUnsupported, TYPE_INT_BOOLEAN, TYPE_INT_DEC, TYPE_INT_HEX } from "./resourcesProto";

const EXTRACT_NATIVE_LIBS_ID = 0x010104ea;
const NAME_ID = 0x01010003;
const VALUE_ID = 0x01010024;
const FUSED_META = "com.android.dynamic.apk.fused.modules";
const SPLIT_ATTRS = new Set(["isSplitRequired", "requiredSplitTypes", "splitTypes"]);
const SPLIT_META = new Set(["com.android.vending.splits.required", "com.android.vending.splits"]);

export interface ManifestInfo {
  packageName: string;
  versionName: string;
  versionCode: string;
  minSdk: number;
  targetSdk: number | null;
  hasSplitName: boolean;
}

function attr(el: XElement, ns: string, name: string): XAttribute | undefined {
  return el.attributes.find((a) => a.ns === ns && a.name === name);
}

function attrText(a: XAttribute | undefined): string | null {
  if (!a) return null;
  if (a.compiled && "item" in a.compiled) {
    const { dataType, data } = a.compiled.item;
    if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) return String(data | 0);
    return null;
  }
  if (a.compiled && "text" in a.compiled) return a.compiled.text;
  return a.value;
}

function sdkNumber(a: XAttribute | undefined, what: string): number | null {
  const t = attrText(a);
  if (t === null) return null;
  if (!/^\d+$/.test(t)) throw new ResourcesUnsupported(`${what} is a preview codename (${t})`);
  return parseInt(t, 10);
}

export function child(el: XElement, name: string, ns = ""): XElement | undefined {
  return el.children.find((c): c is XElement => c.kind === "element" && c.name === name && c.ns === ns);
}

export function readManifestInfo(root: XElement): ManifestInfo {
  if (root.name !== "manifest" || root.ns !== "") throw new ResourcesUnsupported("manifest root is not <manifest>");
  const usesSdk = child(root, "uses-sdk");
  const minSdk = usesSdk ? sdkNumber(attr(usesSdk, ANDROID_NS, "minSdkVersion"), "minSdkVersion") : null;
  const targetSdk = usesSdk ? sdkNumber(attr(usesSdk, ANDROID_NS, "targetSdkVersion"), "targetSdkVersion") : null;
  return {
    packageName: attrText(attr(root, "", "package")) ?? "",
    versionName: attrText(attr(root, ANDROID_NS, "versionName")) ?? "",
    versionCode: attrText(attr(root, ANDROID_NS, "versionCode")) ?? "",
    minSdk: minSdk ?? 1,
    targetSdk,
    hasSplitName: !!attr(root, "", "split"),
  };
}

/**
 * Edit the base manifest in place for a standalone APK, as bundletool does for
 * a universal APK: drop split-only attributes, split meta-data and the
 * distribution namespace, record the fused modules, and set extractNativeLibs
 * to match how native libraries are stored (null: no native libraries, leave it).
 */
export function editManifest(root: XElement, fusedModules: string[], extractNativeLibs: boolean | null): void {
  const strip = (el: XElement) => {
    el.attributes = el.attributes.filter((a) => !(a.ns === ANDROID_NS && SPLIT_ATTRS.has(a.name)) && a.ns !== DIST_NS);
  };
  strip(root);
  root.namespaces = root.namespaces.filter((n) => n.uri !== DIST_NS);
  root.children = root.children.filter((c) => c.kind !== "element" || c.ns !== DIST_NS);
  const app = child(root, "application");
  if (!app) return;
  strip(app);
  app.children = app.children.filter((c) => {
    if (c.kind !== "element" || c.name !== "meta-data") return true;
    const name = attrText(attr(c, ANDROID_NS, "name"));
    return !(name && (SPLIT_META.has(name) || name === FUSED_META));
  });
  const str = (name: string, id: number, text: string): XAttribute => ({
    ns: ANDROID_NS,
    name,
    value: text,
    resourceId: id,
    compiled: { text },
  });
  if (extractNativeLibs !== null) {
    const value: XAttribute = {
      ns: ANDROID_NS,
      name: "extractNativeLibs",
      value: extractNativeLibs ? "true" : "false",
      resourceId: EXTRACT_NATIVE_LIBS_ID,
      compiled: { item: { dataType: TYPE_INT_BOOLEAN, data: extractNativeLibs ? 0xffffffff : 0 } },
    };
    const i = app.attributes.findIndex((a) => a.ns === ANDROID_NS && a.name === "extractNativeLibs");
    if (i >= 0) app.attributes[i] = value;
    else app.attributes.push(value);
  }
  app.children.push({
    kind: "element",
    ns: "",
    name: "meta-data",
    line: 0,
    namespaces: [],
    attributes: [str("name", NAME_ID, FUSED_META), str("value", VALUE_ID, fusedModules.join(","))],
    children: [],
  });
}

export type ModuleKind =
  | { kind: "asset-pack"; delivery: "install-time" | "fast-follow" | "on-demand" | "unknown" }
  | { kind: "feature" };

/** Read a non-base module's `<dist:module>` declaration. */
export function readModuleKind(root: XElement): ModuleKind {
  const mod = child(root, "module", DIST_NS);
  const type = mod ? attrText(attr(mod, DIST_NS, "type")) : null;
  if (type !== "asset-pack") return { kind: "feature" };
  const delivery = mod ? child(mod, "delivery", DIST_NS) : undefined;
  if (delivery) {
    if (child(delivery, "install-time", DIST_NS)) return { kind: "asset-pack", delivery: "install-time" };
    if (child(delivery, "fast-follow", DIST_NS)) return { kind: "asset-pack", delivery: "fast-follow" };
    if (child(delivery, "on-demand", DIST_NS)) return { kind: "asset-pack", delivery: "on-demand" };
  }
  return { kind: "asset-pack", delivery: "unknown" };
}

/** Android version names for the preflight line "Installs on Android X and newer". */
const VERSION_NAMES: [number, string][] = [
  [36, "16"], [35, "15"], [34, "14"], [33, "13"], [32, "12L"], [31, "12"], [30, "11"], [29, "10"],
  [28, "9"], [27, "8.1"], [26, "8.0"], [25, "7.1"], [24, "7.0"], [23, "6.0"], [22, "5.1"], [21, "5.0"],
  [19, "4.4"], [18, "4.3"], [17, "4.2"], [16, "4.1"], [15, "4.0.3"], [14, "4.0"],
];

export function androidVersionName(sdk: number): string {
  for (const [api, name] of VERSION_NAMES) if (sdk >= api) return name;
  return "1.0";
}
