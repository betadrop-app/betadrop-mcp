// betadrop_inspect's local checks, betadrop_android_registration and betadrop_convert_aab, on the
// website's own fixtures (read by path, never copied here).
import os from "node:os";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { call, connect, fakeApi, ok } from "./helpers.js";

const LIB = path.resolve(__dirname, "../../src/lib");
const fixture = (rel: string) => path.join(LIB, rel);
/** The fixtures are the website's, beside this package in the monorepo. The public mirror carries
 *  only the website code the package runs (web-src/), so these tests skip there. */
const itWithFixtures = existsSync(path.join(LIB, "pageSize16k/fixtures")) ? it : it.skip;

const PACKAGE = "app.betadrop.verification.fixture";
const SHA256 = "E15A3E9B2EFDE58C9896931E44D3AC4CEEE7C5A894E9B39E470B4B9DF829EA14";
const colon = (hex: string) => hex.match(/.{2}/g)!.join(":");

let api: Awaited<ReturnType<typeof fakeApi>> | undefined;
let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, BETADROP_TOKEN: process.env.BETADROP_TOKEN };
let registrations: unknown[] = [];

/** What the fake registration endpoint answers; a test can change it. */
let registrationAnswer: { status: number; body: unknown };

/** BetaDrop's inspect answer for the fixture APK, as `/api/inspect` sends it. */
const INSPECT_REPORT = {
  fileName: "verification-v2.apk",
  platform: "android",
  installableFromLink: true,
  checks: [{ id: "signed", level: "ok", message: "Signed with APK Signature Scheme v2." }],
  app: { name: "Fixture", bundleId: PACKAGE, version: "1.0", buildNumber: "1" },
  ios: null,
  android: { versionCode: 1, targetSdk: 35, debuggable: false },
};

/**
 * The API: the registration lookup, and /api/inspect for the signed-in cases. One server per test:
 * closing one waits out the keep-alive socket the lookup's fetch left open.
 */
async function startApi() {
  registrations = [];
  registrationAnswer = { status: 200, body: { status: "not_registered", package: PACKAGE, cert_sha256: SHA256, all_sources_from: null } };
  api = await fakeApi({
    "/api/tools/android-registration": (req) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => registrations.push(JSON.parse(body)));
      return registrationAnswer;
    },
    "/api/inspect": ok(INSPECT_REPORT),
  });
}

beforeEach(async () => {
  // A scratch home: no stored token, and the test signing key is the test's own.
  home = await fs.mkdtemp(path.join(os.tmpdir(), "betadrop-mcp-checks-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  delete process.env.BETADROP_TOKEN;
  await startApi();
});

afterEach(async () => {
  // Not awaited: closing waits out the upload's keep-alive socket (seconds), and each test has its own port.
  void api?.close();
  api = undefined;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
});

/** A provisioning profile as Apple ships it: DER around an XML plist. The decoder only needs the plist. */
function profileBytes(over: { type?: "adhoc" | "appstore"; expires?: Date; bundleId?: string; devices?: string[] } = {}) {
  const expires = over.expires ?? new Date(Date.now() + 200 * 86_400_000);
  const devices = over.type === "appstore" ? [] : (over.devices ?? ["00008110-000A1B2C3D4E5F60", "00008030-001122334455667E"]);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key><string>ShopEase</string>
  <key>ApplicationIdentifierPrefix</key><array><string>ABCDE12345</string></array>
  <key>CreationDate</key><date>2026-01-02T03:04:05Z</date>
  <key>Platform</key><array><string>iOS</string></array>
  <key>DeveloperCertificates</key><array><data>MIIBAAAA</data></array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>ABCDE12345.${over.bundleId ?? "com.shop.ease"}</string>
    <key>get-task-allow</key><false/>
    <key>keychain-access-groups</key><array><string>ABCDE12345.*</string></array>
  </dict>
  <key>ExpirationDate</key><date>${expires.toISOString().replace(/\.\d+Z$/, "Z")}</date>
  <key>Name</key><string>ShopEase Ad Hoc</string>
  ${devices.length ? `<key>ProvisionedDevices</key><array>${devices.map((d) => `<string>${d}</string>`).join("")}</array>` : ""}
  <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
  <key>TeamName</key><string>Shop Ltd</string>
  <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
  <key>Version</key><integer>1</integer>
</dict>
</plist>`;
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x10, 0x00, 0x06, 0x09]), Buffer.from(xml, "utf8"), Buffer.from([0xa0, 0x82, 0x01])]);
}

async function writeIpa(name: string, profile: Buffer | null, bundleId = "com.shop.ease"): Promise<string> {
  const zip = new JSZip();
  zip.file(
    "Payload/ShopEase.app/Info.plist",
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundleId}</string>
      <key>CFBundleDisplayName</key><string>ShopEase</string>
      <key>CFBundleShortVersionString</key><string>2.4.1</string>
      <key>CFBundleVersion</key><string>241</string>
      <key>MinimumOSVersion</key><string>16.0</string>
    </dict></plist>`,
  );
  zip.file("Payload/ShopEase.app/ShopEase", "binary");
  if (profile) zip.file("Payload/ShopEase.app/embedded.mobileprovision", profile);
  const file = path.join(home, name);
  await fs.writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

describe("betadrop_inspect, signed out", () => {
  itWithFixtures("reads an APK's signing schemes, certificate and Google registration, and says the install-link verdict needs sign-in", async () => {
    const { text, isError } = await call(await connect(), "betadrop_inspect", {
      filePath: fixture("androidVerification/fixtures/verification-v1-v2-v3.apk"),
    });
    expect(isError).toBe(false);
    expect(text).toContain(PACKAGE);
    expect(text).toMatch(/✓ Signed with APK Signature Scheme v1, v2, v3/);
    expect(text).toContain(`Signing certificate SHA-256: ${colon(SHA256)}`);
    expect(text).toContain("! Not registered with Google.");
    expect(text).toContain("needs a signed-in account (betadrop_login)");
    // Only the package and the fingerprint went out, and no file upload was attempted.
    await expect.poll(() => registrations).toEqual([{ package: PACKAGE, cert_sha256: SHA256 }]);
    expect(api!.seen.map((r) => r.url)).toEqual(["/api/tools/android-registration"]);
  });

  itWithFixtures("marks an unsigned APK and skips the registration lookup", async () => {
    const { text } = await call(await connect(), "betadrop_inspect", {
      filePath: fixture("androidVerification/fixtures/verification-unsigned.apk"),
    });
    expect(text).toContain("✗ Not signed. Android won't install an unsigned APK.");
    expect(registrations).toEqual([]);
  });

  itWithFixtures("reports the 16 KB page size check for an APK, naming the failing libraries", async () => {
    const good = await call(await connect(), "betadrop_inspect", { filePath: fixture("pageSize16k/fixtures/apk-16k-P16.apk") });
    expect(good.text).toContain("✓ This APK supports 16 KB page sizes");

    const bad = await call(await connect(), "betadrop_inspect", { filePath: fixture("pageSize16k/fixtures/apk-4k-P16.apk") });
    expect(bad.text).toContain("✗ This APK does not support 16 KB page sizes");
    expect(bad.text).toMatch(/✗ lib\/arm64-v8a\/[^:]+\.so: LOAD segments not 16 KB aligned \(4 KB\)/);
    expect(bad.text).toContain("Local checks: ");
  });

  itWithFixtures("reads an App Bundle: its details, the 16 KB check and that it doesn't install from a link", async () => {
    const good = await call(await connect(), "betadrop_inspect", { filePath: fixture("pageSize16k/fixtures/aab-16k.aab") });
    expect(good.isError).toBe(false);
    expect(good.text).toContain("android app bundle");
    expect(good.text).toContain("minSdk");
    expect(good.text).toContain("Modules: base");
    expect(good.text).toContain("✓ This bundle supports 16 KB page sizes");
    expect(good.text).toContain("An .aab doesn't install from a link");

    const bad = await call(await connect(), "betadrop_inspect", { filePath: fixture("pageSize16k/fixtures/aab-4k.aab") });
    expect(bad.text).toContain("✗ This bundle does not support 16 KB page sizes");
    expect(bad.text).toContain("PAGE_ALIGNMENT_4K");
    // Bundles never go to /api/inspect.
    expect(api!.seen.some((r) => r.url === "/api/inspect")).toBe(false);
  });

  it("decodes a .mobileprovision: type, team, expiry, devices and entitlements", async () => {
    const file = path.join(home, "ShopEase_AdHoc.mobileprovision");
    await fs.writeFile(file, profileBytes());
    const { text, isError } = await call(await connect(), "betadrop_inspect", { filePath: file });
    expect(isError).toBe(false);
    expect(text).toContain("**ShopEase Ad Hoc** · Ad Hoc provisioning profile · team Shop Ltd (ABCDE12345)");
    expect(text).toContain("App ID com.shop.ease");
    expect(text).toContain("✓ Ad Hoc profile");
    expect(text).toMatch(/✓ Valid until \d{4}-\d{2}-\d{2}/);
    expect(text).toContain("✓ 2 devices listed");
    expect(text).toContain("00008110-000A1B2C3D4E5F60");
    expect(text).toContain("get-task-allow = false");
    expect(text).toContain("Verdict: an Ad Hoc profile");
  });

  it("flags an expired App Store profile", async () => {
    const file = path.join(home, "old.mobileprovision");
    await fs.writeFile(file, profileBytes({ type: "appstore", expires: new Date("2025-01-01T00:00:00Z") }));
    const { text } = await call(await connect(), "betadrop_inspect", { filePath: file });
    expect(text).toContain("✗ App Store profile");
    expect(text).toContain("✗ Expired on 2025-01-01");
    expect(text).toContain("won't install from a link");
  });

  it("reads an .ipa's Info.plist and embedded profile, and catches a bundle ID the profile doesn't cover", async () => {
    const good = await call(await connect(), "betadrop_inspect", { filePath: await writeIpa("good.ipa", profileBytes()) });
    expect(good.text).toContain("**ShopEase** 2.4.1 (241) · ios · com.shop.ease");
    expect(good.text).toContain("Minimum iOS 16.0");
    expect(good.text).toContain("✓ Covers the app's bundle ID com.shop.ease");
    expect(good.text).toContain("needs a signed-in account");

    const wrong = await call(await connect(), "betadrop_inspect", {
      filePath: await writeIpa("wrong.ipa", profileBytes({ bundleId: "com.other.app" })),
    });
    expect(wrong.text).toContain("✗ The profile is for com.other.app, but the app's bundle ID is com.shop.ease.");

    const none = await call(await connect(), "betadrop_inspect", { filePath: await writeIpa("none.ipa", null) });
    expect(none.text).toContain("✗ No embedded.mobileprovision");
  });

  it("refuses other file types", async () => {
    const { text, isError } = await call(await connect(), "betadrop_inspect", { filePath: "/tmp/x.zip" });
    expect(isError).toBe(true);
    expect(text).toContain("Expected .ipa, .apk, .aab or .mobileprovision");
  });
});

describe("betadrop_inspect, signed in", () => {
  itWithFixtures("adds BetaDrop's install-link verdict to the local checks of an APK", async () => {
    process.env.BETADROP_TOKEN = "bd_live_test";
    const { text, isError } = await call(await connect(), "betadrop_inspect", {
      filePath: fixture("androidVerification/fixtures/verification-v2.apk"),
    });
    expect(isError).toBe(false);
    expect(text).toContain("✓ Signed with APK Signature Scheme v2.");
    expect(text).toContain("**Install link (BetaDrop)**");
    expect(text).toContain("Verdict: installable from an install link.");
    expect(text).not.toContain("needs a signed-in account");
    expect(api!.seen.some((r) => r.url === "/api/inspect" && r.auth === "Bearer bd_live_test")).toBe(true);
  });
});

describe("betadrop_android_registration", () => {
  it("is on the hosted connector, and looks up a pasted package and fingerprint", async () => {
    const client = await connect(true);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("betadrop_android_registration");
    expect(names).not.toContain("betadrop_inspect");
    expect(names).not.toContain("betadrop_convert_aab");

    const { text, isError } = await call(client, "betadrop_android_registration", {
      packageName: PACKAGE,
      certSha256: `SHA256: ${colon(SHA256).toLowerCase()}`,
    });
    expect(isError).toBe(false);
    expect(text).toContain(`**${PACKAGE}** · signing certificate SHA-256 ${colon(SHA256)}`);
    expect(text).toContain("! Not registered with Google.");
    await expect.poll(() => registrations).toEqual([{ package: PACKAGE, cert_sha256: SHA256 }]);
  });

  it("says when a SHA-1 was given instead, without asking Google", async () => {
    const { text, isError } = await call(await connect(true), "betadrop_android_registration", {
      packageName: PACKAGE,
      certSha256: "AB".repeat(20),
    });
    expect(isError).toBe(true);
    expect(text).toContain("SHA-1");
    expect(registrations).toEqual([]);
  });

  it("words a check that isn't available yet", async () => {
    registrationAnswer = { status: 503, body: { error: "not_available" } };
    const { text } = await call(await connect(true), "betadrop_android_registration", { packageName: PACKAGE, certSha256: SHA256 });
    expect(text).toContain("isn't available right now");
  });
});

describe("betadrop_convert_aab", () => {
  const AAB = fixture("appIcon/buildCheck/fixtures/android-adaptive.aab");

  itWithFixtures("writes a universal APK next to a copy of the bundle, signed with a reused test key, and says so", async () => {
    const input = path.join(home, "app-release.aab");
    await fs.copyFile(AAB, input);
    const client = await connect();

    const first = await call(client, "betadrop_convert_aab", { filePath: input });
    expect(first.isError, first.text).toBe(false);
    const apk = path.join(home, "app-release.apk");
    const bytes = await fs.readFile(apk);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(first.text).toContain(`to **${apk}**`);
    expect(first.text).toContain("not the developer's upload or release key");
    expect(first.text).toContain("It won't install over a copy from Google Play");
    expect(first.text).toContain("Google Play takes the .aab, not this APK");
    expect(first.text).toContain("betadrop_publish");
    const sha256 = /Certificate SHA-256: ([0-9A-F:]+)/.exec(first.text)![1];

    // The key is kept, owner-only, and the APK really is signed with it.
    const keyFile = path.join(home, ".config", "betadrop", "aab-test-key.json");
    if (process.platform !== "win32") expect((await fs.stat(keyFile)).mode & 0o777).toBe(0o600);
    const inspected = await call(client, "betadrop_inspect", { filePath: apk });
    expect(inspected.text).toMatch(/✓ Signed with APK Signature Scheme (v1, )?v2\./);
    expect(inspected.text).toContain(`Signing certificate SHA-256: ${sha256}`);

    // An existing APK is left alone unless asked.
    const again = await call(client, "betadrop_convert_aab", { filePath: input });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already exists");

    const second = await call(client, "betadrop_convert_aab", { filePath: input, overwrite: true });
    expect(second.text).toContain(`Certificate SHA-256: ${sha256}`);
    expect(second.text).toContain("same test key as earlier conversions");

    const fresh = await call(client, "betadrop_convert_aab", { filePath: input, overwrite: true, newTestKey: true });
    expect(fresh.text).not.toContain(`Certificate SHA-256: ${sha256}`);
    expect(fresh.text).toContain("A new test key was made");
  });

  itWithFixtures("refuses an APK, and is not on the hosted connector", async () => {
    const local = await call(await connect(), "betadrop_convert_aab", { filePath: fixture("pageSize16k/fixtures/apk-no-native.apk") });
    expect(local.isError).toBe(true);
    expect(local.text).toContain("Expected an .aab");

    const remote = await call(await connect(true), "betadrop_convert_aab", { filePath: AAB });
    expect(remote.isError).toBe(true);
    expect(remote.text).toContain("npx -y @betadrop/mcp");
  });
});
