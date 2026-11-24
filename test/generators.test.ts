import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import jpeg from "jpeg-js";
import jsQR from "jsqr";
import plist from "plist";
import { PNG } from "pngjs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Canvas, SourceImage } from "../src/lib/icons/raster.js";
import { connect } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "betadrop-mcp-gen-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

type Content = { type: string; text?: string; data?: string; mimeType?: string };

async function run(name: string, args: Record<string, unknown>, remote = false) {
  const client = await connect(remote);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  const content = res.content as Content[];
  return {
    text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
    images: content.filter((c) => c.type === "image"),
    isError: res.isError === true,
  };
}

/** A transparent 1024 px PNG with a blue disc: a logo. `side` makes it smaller. */
async function logoPng(side = 1024): Promise<string> {
  const png = new PNG({ width: side, height: side });
  const c = side / 2;
  const r = side * 0.3;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      const inside = Math.hypot(x + 0.5 - c, y + 0.5 - c) < r;
      png.data.set(inside ? [11, 100, 252, 255] : [0, 0, 0, 0], i);
    }
  }
  const file = path.join(dir, `logo-${side}.png`);
  await fs.writeFile(file, PNG.sync.write(png));
  return file;
}

/** An opaque JPEG: a finished, edge-to-edge icon. */
async function fullJpeg(): Promise<string> {
  const side = 1024;
  const data = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) data.set([200, Math.round((x / side) * 255), Math.round((y / side) * 255), 255], (y * side + x) * 4);
  }
  const file = path.join(dir, "icon.jpg");
  await fs.writeFile(file, jpeg.encode({ width: side, height: side, data }, 90).data);
  return file;
}

async function pngHeader(file: string) {
  const bytes = await fs.readFile(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

describe("betadrop_app_icons", () => {
  it("writes the web generator's native iOS and Android sets, with the sizes and Contents.json Xcode reads", async () => {
    const image = await logoPng();
    const out = path.join(dir, "out");
    const { text, images, isError } = await run("betadrop_app_icons", { imagePath: image, outputDir: out });
    expect(isError, text).toBe(false);
    expect(text).toContain("logo on #FFFFFF, padding 18%");
    expect(text).toContain("✓ Export verified");
    expect(images[0]?.mimeType).toBe("image/png");

    const set = path.join(out, "ios/AppIcon.appiconset");
    const contents = JSON.parse(await fs.readFile(path.join(set, "Contents.json"), "utf8")) as {
      images: Array<{ filename: string; idiom: string; platform?: string; size: string; appearances?: unknown[] }>;
    };
    expect(contents.images.map((i) => i.filename)).toEqual(["AppIcon-1024.png", "AppIcon-1024-dark.png", "AppIcon-1024-tinted.png"]);
    for (const entry of contents.images) expect(entry).toMatchObject({ idiom: "universal", platform: "ios", size: "1024x1024" });
    // The App Store icon has no alpha channel (colour type 2); the dark and tinted ones keep theirs.
    expect(await pngHeader(path.join(set, "AppIcon-1024.png"))).toEqual({ width: 1024, height: 1024, colorType: 2 });
    expect(await pngHeader(path.join(set, "AppIcon-1024-dark.png"))).toEqual({ width: 1024, height: 1024, colorType: 6 });
    expect(await pngHeader(path.join(out, "store/app-store-1024.png"))).toMatchObject({ width: 1024, colorType: 2 });
    expect(await pngHeader(path.join(out, "store/play-store-512.png"))).toMatchObject({ width: 512, colorType: 6 });

    const res = path.join(out, "android/app/src/main/res");
    for (const [density, scale] of [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]] as const) {
      expect((await pngHeader(path.join(res, `mipmap-${density}/ic_launcher.png`))).width).toBe(48 * scale);
      expect((await pngHeader(path.join(res, `mipmap-${density}/ic_launcher_round.png`))).width).toBe(48 * scale);
      expect((await pngHeader(path.join(res, `mipmap-${density}/ic_launcher_foreground.png`))).width).toBe(108 * scale);
      expect((await pngHeader(path.join(res, `mipmap-${density}/ic_launcher_monochrome.png`))).width).toBe(108 * scale);
    }
    const adaptive = await fs.readFile(path.join(res, "mipmap-anydpi-v26/ic_launcher.xml"), "utf8");
    expect(adaptive).toContain('<background android:drawable="@color/ic_launcher_background"/>');
    expect(adaptive).toContain('<monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>');
    expect(await fs.readFile(path.join(res, "values/ic_launcher_background.xml"), "utf8")).toContain("#FFFFFF");

    const readme = await fs.readFile(path.join(out, "README.txt"), "utf8");
    expect(readme).toContain("BetaDrop MCP server");
    expect(readme).not.toContain("in your browser");

    // The art really is drawn: the centre of the App Store icon is the logo's blue, the corner the white background.
    const icon = PNG.sync.read(await fs.readFile(path.join(out, "store/app-store-1024.png")));
    const at = (x: number, y: number) => Array.from(icon.data.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 3));
    expect(at(512, 512)).toEqual([11, 100, 252]);
    expect(at(4, 4)).toEqual([255, 255, 255]);
  });

  it("only writes the platform asked for, and treats an opaque JPEG as a full icon", async () => {
    const out = path.join(dir, "out");
    const { text, isError } = await run("betadrop_app_icons", { imagePath: await fullJpeg(), outputDir: out, platforms: "android" });
    expect(isError, text).toBe(false);
    expect(text).toContain("full icon on #");
    await expect(fs.stat(path.join(out, "ios"))).rejects.toThrow();
    await expect(fs.stat(path.join(out, "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"))).resolves.toBeTruthy();
    expect(text).toContain("No themed (monochrome) icon");
    expect(text).not.toMatch(/More options|under “/);
  });

  it("warns when the source is too small for the 1024 px icon", async () => {
    const { text, isError } = await run("betadrop_app_icons", { imagePath: await logoPng(256), outputDir: path.join(dir, "out") });
    expect(isError).toBe(false);
    expect(text).toMatch(/! 256 × 256 px is too small for the 1024 px icon/);
  });

  it("replaces a project's own icon set and launcher icons, removing the files that would clash", async () => {
    const project = path.join(dir, "MyFlutterApp");
    const set = path.join(project, "ios/Runner/Assets.xcassets/AppIcon.appiconset");
    const macSet = path.join(project, "macos/Runner/Assets.xcassets/AppIcon.appiconset");
    const res = path.join(project, "android/app/src/main/res");
    for (const d of [set, macSet, path.join(res, "mipmap-hdpi"), path.join(res, "values"), path.join(project, "android/app/build/intermediates/res")]) {
      await fs.mkdir(d, { recursive: true });
    }
    await fs.writeFile(path.join(set, "Icon-App-20x20@2x.png"), "old");
    await fs.writeFile(path.join(set, "Contents.json"), "{}");
    await fs.writeFile(path.join(macSet, "app_icon_16.png"), "mac");
    await fs.writeFile(path.join(res, "mipmap-hdpi/ic_launcher.webp"), "old");
    await fs.writeFile(path.join(res, "mipmap-hdpi/other.png"), "keep");
    await fs.writeFile(path.join(res, "values/colors.xml"), '<resources><color name="ic_launcher_background">#000000</color></resources>');

    const { text, isError } = await run("betadrop_app_icons", { imagePath: await logoPng(), projectDir: project });
    expect(isError, text).toBe(false);
    await expect(fs.stat(path.join(set, "Icon-App-20x20@2x.png"))).rejects.toThrow();
    expect(JSON.parse(await fs.readFile(path.join(set, "Contents.json"), "utf8")).images).toHaveLength(3);
    expect(await fs.readFile(path.join(macSet, "app_icon_16.png"), "utf8")).toBe("mac");
    await expect(fs.stat(path.join(res, "mipmap-hdpi/ic_launcher.webp"))).rejects.toThrow();
    expect((await pngHeader(path.join(res, "mipmap-hdpi/ic_launcher.png"))).width).toBe(72);
    expect(await fs.readFile(path.join(res, "mipmap-hdpi/other.png"), "utf8")).toBe("keep");
    expect(text).toContain("Removed 2 old icon files");
    expect(text).toContain("values/colors.xml also defines the colour ic_launcher_background");
    await expect(fs.stat(path.join(project, "store"))).rejects.toThrow();
  });

  it("says which sets it found when a project has more than one", async () => {
    const project = path.join(dir, "Two");
    for (const app of ["A", "B"]) await fs.mkdir(path.join(project, app, "Assets.xcassets/AppIcon.appiconset"), { recursive: true });
    const { text, isError } = await run("betadrop_app_icons", { imagePath: await logoPng(), projectDir: project, platforms: "ios" });
    expect(isError).toBe(true);
    expect(text).toContain("2 iOS app icon sets");
    expect(text).toContain("A/Assets.xcassets/AppIcon.appiconset");
  });

  it("is local only: the hosted connector neither lists nor runs it", async () => {
    const client = await connect(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("betadrop_app_icons");
    expect(names).toEqual(expect.arrayContaining(["betadrop_generate_plist", "betadrop_qr_code"]));
    const { isError, text } = await run("betadrop_app_icons", { imagePath: "/x.png" }, true);
    expect(isError).toBe(true);
    expect(text).toContain("npx -y @betadrop/mcp");
  });

  it("refuses formats it cannot decode, naming the ones it reads", async () => {
    const file = path.join(dir, "icon.svg");
    await fs.writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
    const { text, isError } = await run("betadrop_app_icons", { imagePath: file });
    expect(isError).toBe(true);
    expect(text).toContain("PNG and JPEG");
  });
});

describe("raster scaling", () => {
  it("averages the area under each pixel when shrinking, rather than picking one source pixel", () => {
    // A 1-pixel checkerboard shrunk 1024 → 48 is an even grey everywhere; nearest-neighbour gives black and white.
    const side = 1024;
    const data = new Uint8Array(side * side * 4);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) data.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * side + x) * 4);
    const c = new Canvas(48, 48);
    c.drawContained(new SourceImage({ width: side, height: side, data }), { x: 0, y: 0, w: 48, h: 48 });
    const out = c.toRgba();
    for (let i = 0; i < out.length; i += 4) {
      expect(Math.abs(out[i] - 127.5)).toBeLessThan(2);
      expect(out[i + 3]).toBe(255);
    }
  });

  it("gives a fractional edge partial coverage", () => {
    const data = new Uint8Array(4 * 4 * 4).fill(255);
    const c = new Canvas(8, 8);
    c.drawScaled(new SourceImage({ width: 4, height: 4, data }), 2.5, 2.5, 1);
    const alpha = (x: number, y: number) => c.toRgba()[(y * 8 + x) * 4 + 3];
    expect(alpha(2, 4)).toBe(128);
    expect(alpha(4, 4)).toBe(255);
    expect(alpha(1, 4)).toBe(0);
  });
});

describe("betadrop_generate_plist", () => {
  it("writes an ExportOptions.plist with the web generator's keys, and the export commands", async () => {
    const { text, isError } = await run("betadrop_generate_plist", {
      kind: "exportOptions",
      method: "app-store-connect",
      teamID: "ABCDE12345",
      bundleId: "com.example.app",
      provisioningProfile: "MyApp App Store",
      provisioningProfiles: { "com.example.app.widget": "MyApp Widget" },
      scheme: "MyApp",
    });
    expect(isError, text).toBe(false);
    const xml = /```xml\n([\s\S]*?)\n```/.exec(text)![1];
    expect(plist.parse(xml)).toEqual({
      method: "app-store-connect",
      teamID: "ABCDE12345",
      signingStyle: "manual",
      provisioningProfiles: { "com.example.app": "MyApp App Store", "com.example.app.widget": "MyApp Widget" },
      destination: "export",
      thinning: "<none>",
      stripSwiftSymbols: true,
      uploadSymbols: true,
    });
    expect(text).toContain("-archivePath build/MyApp.xcarchive");
    expect(text).toContain('build_app(\n  scheme: "MyApp",');
  });

  it("leaves profiles out under automatic signing", async () => {
    const { text } = await run("betadrop_generate_plist", { kind: "exportOptions", signingStyle: "automatic", method: "debugging" });
    const parsed = plist.parse(/```xml\n([\s\S]*?)\n```/.exec(text)![1]) as Record<string, unknown>;
    expect(parsed).toMatchObject({ method: "debugging", signingStyle: "automatic" });
    expect(parsed.provisioningProfiles).toBeUndefined();
  });

  it("refuses the deprecated method names, manual signing without a profile, and wildcard IDs", async () => {
    const legacy = await run("betadrop_generate_plist", { kind: "exportOptions", method: "ad-hoc", bundleId: "a.b", provisioningProfile: "P" });
    expect(legacy.isError).toBe(true);
    expect(legacy.text).toContain('"release-testing"');
    const noProfile = await run("betadrop_generate_plist", { kind: "exportOptions" });
    expect(noProfile.isError).toBe(true);
    expect(noProfile.text).toContain("Manual signing needs a provisioning profile");
    const wildcard = await run("betadrop_generate_plist", { kind: "exportOptions", bundleId: "com.example.*", provisioningProfile: "P" });
    expect(wildcard.isError).toBe(true);
  });

  it("writes a manifest.plist and its install link, with the URL percent-encoded", async () => {
    const { text, isError } = await run("betadrop_generate_plist", {
      kind: "manifest",
      ipaUrl: "https://cdn.example.com/MyApp.ipa?sig=a&b=1",
      bundleId: "com.example.app",
      bundleVersion: "2.4.0",
      title: "My App",
      displayImageUrl: "https://cdn.example.com/57.png",
      manifestUrl: "https://cdn.example.com/manifest.plist?t=1&u=2",
    });
    expect(isError, text).toBe(false);
    const parsed = plist.parse(/```xml\n([\s\S]*?)\n```/.exec(text)![1]) as {
      items: Array<{ assets: Array<{ kind: string; url: string }>; metadata: Record<string, string> }>;
    };
    expect(parsed.items[0].assets).toEqual([
      { kind: "software-package", url: "https://cdn.example.com/MyApp.ipa?sig=a&b=1" },
      { kind: "display-image", url: "https://cdn.example.com/57.png" },
    ]);
    expect(parsed.items[0].metadata).toEqual({ "bundle-identifier": "com.example.app", "bundle-version": "2.4.0", kind: "software", title: "My App" });
    expect(text).toContain("itms-services://?action=download-manifest&url=https%3A%2F%2Fcdn.example.com%2Fmanifest.plist%3Ft%3D1%26u%3D2");
    expect(text).toContain("What the text alone can't confirm");
  });

  it("refuses a manifest with a plain http URL or missing metadata", async () => {
    const http = await run("betadrop_generate_plist", { kind: "manifest", ipaUrl: "http://x.com/a.ipa", bundleId: "a", bundleVersion: "1", title: "A" });
    expect(http.isError).toBe(true);
    expect(http.text).toContain("https://");
    const missing = await run("betadrop_generate_plist", { kind: "manifest", ipaUrl: "https://x.com/a.ipa" });
    expect(missing.text).toContain("bundleId, bundleVersion, title");
  });

  it("saves to a new file locally, never over an existing one, and not at all on the hosted connector", async () => {
    const file = path.join(dir, "ExportOptions.plist");
    const args = { kind: "exportOptions", signingStyle: "automatic", outputPath: file };
    expect((await run("betadrop_generate_plist", args)).isError).toBe(false);
    expect(plist.parse(await fs.readFile(file, "utf8"))).toMatchObject({ signingStyle: "automatic" });
    const again = await run("betadrop_generate_plist", args);
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already exists");
    const hosted = await run("betadrop_generate_plist", { ...args, outputPath: path.join(dir, "other.plist") }, true);
    expect(hosted.isError).toBe(true);
    await expect(fs.stat(path.join(dir, "other.plist"))).rejects.toThrow();
  });
});

describe("betadrop_qr_code", () => {
  const link = "https://betadrop.app/i/aB3xYz";

  it("returns a PNG of the asked size that decodes back to the link", async () => {
    for (const remote of [false, true]) {
      const { images, text, isError } = await run("betadrop_qr_code", { url: link, size: 256 }, remote);
      expect(isError, text).toBe(false);
      const png = PNG.sync.read(Buffer.from(images[0].data!, "base64"));
      expect([png.width, png.height]).toEqual([256, 256]);
      expect(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data).toBe(link);
      expect(text).toContain("error correction H");
    }
  });

  it("defaults to 512 px, and saves an SVG locally", async () => {
    const file = path.join(dir, "qr.svg");
    const { images } = await run("betadrop_qr_code", { url: link, outputPath: file });
    expect(PNG.sync.read(Buffer.from(images[0].data!, "base64")).width).toBe(512);
    expect(await fs.readFile(file, "utf8")).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });

  it("refuses text that is not a URL, and a link too long for a QR code", async () => {
    expect((await run("betadrop_qr_code", { url: "not a link" })).isError).toBe(true);
    const long = await run("betadrop_qr_code", { url: `https://example.com/${"a".repeat(3000)}` });
    expect(long.isError).toBe(true);
    expect(long.text).toContain("too long");
  });
});
