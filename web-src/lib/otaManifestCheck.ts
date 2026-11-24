/**
 * Static checks for an iOS over-the-air install link or its manifest.plist.
 *
 * Why this exists: the largest by-intent slice of traffic on /manifest-plist-generator/ is people
 * who already have a link and it does not work. Measured 2026-09-15, the page ranks for raw
 * `itms-services://?action=download-manifest&url=...` strings (629 impressions, 0 clicks): someone
 * pastes their broken link into Google. Those searchers do not want to generate a manifest, they
 * want to know why the one they have is dead. This module is the rule set behind that check.
 *
 * It runs entirely on pasted text and NEVER fetches anything. That is a hard constraint, not a
 * limitation to apologise for: the page's whole posture is that it does not host, fetch, resolve or
 * store URLs, and a share of itms-services searches are people holding a third-party plist URL. So
 * this checks the SHAPE of the link or manifest — the mistakes that are visible in the text itself —
 * and returns, separately, the runtime facts a browser cannot verify (certificate trust, MIME types,
 * redirects, whether the device is in the provisioning profile) for the reader to confirm by hand.
 *
 * Deliberately dependency-free: no `@/` imports, no npm imports, no React. A value import of the
 * `@/` alias breaks any module a plain `node --test` file loads, and this module's test does exactly
 * that. String scans rather than an XML parser keep it that way and keep it small.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface Check {
  status: CheckStatus;
  label: string;
  detail: string;
}

export type OtaInputKind = "link" | "manifest" | "unknown";

export interface OtaAnalysis {
  kind: OtaInputKind;
  checks: Check[];
  /** Runtime facts this static check cannot see; the reader confirms these on their own server. */
  cannotCheck: string[];
}

/** The four things a text check cannot see. Server-rendered nearby too, but returned here so the
 *  result panel always carries them next to the findings. */
const CANNOT_CHECK: string[] = [
  "Both the manifest and the .ipa are served over HTTPS on a certificate the device already trusts. A self-signed certificate is not enough.",
  "The server sends application/octet-stream for the .ipa and text/xml for the manifest. A host that answers text/html for an unknown extension stops the install with no message.",
  "The manifest URL is a direct file, not a redirect, interstitial or login wall.",
  "The link is opened in Safari. In-app browsers inside chat and email clients often do not hand the itms-services scheme to the system.",
  "The tester's device UDID is in the build's provisioning profile. That is signing, not the manifest, and no manifest can override it.",
];

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Everything the link carries after the first `url=`, undecoded. */
function rawUrlValue(link: string): string | null {
  const marker = link.indexOf("url=");
  if (marker === -1) return null;
  return link.slice(marker + 4).trim();
}

function analyzeLink(input: string): Check[] {
  const checks: Check[] = [];
  const link = input.trim();

  // 1. Scheme.
  if (/^https?:\/\//i.test(link)) {
    checks.push({
      status: "fail",
      label: "This is a plain URL, not an install link",
      detail:
        "An install link starts with itms-services://?action=download-manifest&url= and the url is the address of your manifest.plist. Pasting the manifest or .ipa address on its own does not install anything.",
    });
    return checks;
  }
  if (/^itms-services:\/\//i.test(link)) {
    checks.push({
      status: "pass",
      label: "Starts with the itms-services scheme",
      detail: "The operating system claims this scheme, which is why there is no host after the slashes.",
    });
  } else if (/itms-services:\/\//i.test(link)) {
    checks.push({
      status: "warn",
      label: "The itms-services scheme is not at the start",
      detail:
        "The link has to begin with itms-services://. Leading text, a stray space or a wrapping character before it will stop the system from claiming the link.",
    });
  } else {
    checks.push({
      status: "fail",
      label: "No itms-services scheme found",
      detail:
        "A working install link begins itms-services://?action=download-manifest&url=… . If you are checking a manifest.plist instead, paste its XML and this will validate that.",
    });
    return checks;
  }

  // 2. Nested scheme in the url value.
  const raw = rawUrlValue(link);
  if (raw && /^itms-services/i.test(decodeOnce(raw))) {
    checks.push({
      status: "fail",
      label: "The url value is itself an itms-services link",
      detail:
        "The url= parameter must be the https:// address of your manifest.plist, not another itms-services link. A nested link never resolves.",
    });
  }

  // 3. Action.
  if (/action=download-manifest/i.test(link)) {
    checks.push({
      status: "pass",
      label: "action=download-manifest is present",
      detail: "This is the only action in normal use and it is fixed text.",
    });
  } else {
    checks.push({
      status: "fail",
      label: "action=download-manifest is missing",
      detail:
        "Without action=download-manifest the device does not know the url is a manifest to read. Check for a typo such as download-manifests or a missing hyphen.",
    });
  }

  // 4. A url value at all.
  if (raw === null || raw.length === 0) {
    checks.push({
      status: "fail",
      label: "No url= value",
      detail:
        "The link has nothing after url=, so there is no manifest for the device to fetch. The value is the HTTPS address of your manifest.plist.",
    });
    return checks;
  }

  // Isolate just the URL from any trailing itms parameters, then decode for the content checks.
  const rawUrlOnly = raw.split(/&amp;|&/)[0];
  const decoded = decodeOnce(rawUrlOnly);

  // 5. HTTPS.
  if (/^http:\/\//i.test(decoded)) {
    checks.push({
      status: "fail",
      label: "The manifest URL is plain HTTP",
      detail:
        "Apple requires HTTPS for the manifest and the .ipa. A plain http:// address ends the install before it starts, with no message on the device.",
    });
  } else if (/^https:\/\//i.test(decoded)) {
    checks.push({
      status: "pass",
      label: "The manifest URL is HTTPS",
      detail: "Good. The certificate still has to be one the device already trusts, which this check cannot see.",
    });
  } else {
    checks.push({
      status: "warn",
      label: "The url value is not an absolute https:// address",
      detail:
        "The manifest URL should be a full https:// address. A relative path or a bare host will not resolve on the device.",
    });
  }

  // 6. Points at the manifest, not the .ipa.
  const path = decoded.split(/[?#]/)[0];
  if (/\.ipa$/i.test(path)) {
    checks.push({
      status: "fail",
      label: "The link points at the .ipa, not the manifest",
      detail:
        "This is the single most common mistake. The link must carry the address of your manifest.plist; the manifest, in turn, carries the address of the .ipa. Pointing the link at the archive asks the device to read a zip as a property list, and it fails at once.",
    });
  } else if (/\.plist$/i.test(path)) {
    checks.push({
      status: "pass",
      label: "The link points at a .plist",
      detail: "The url addresses a manifest, which is what the link is supposed to carry.",
    });
  } else {
    checks.push({
      status: "warn",
      label: "The URL does not end in .plist",
      detail:
        "The manifest is usually served at a .plist address. If yours is served without that extension, make sure it is the manifest and not the build.",
    });
  }

  // 7. Percent-encoding of the url value.
  const looksEncoded = /%3a%2f%2f|%2f/i.test(raw);
  const query = decoded.split(/[?#]/).slice(1).join("");
  if (!looksEncoded && /:\/\//.test(raw)) {
    if (query.length > 0) {
      checks.push({
        status: "fail",
        label: "The manifest URL has unencoded query characters",
        detail:
          "Your manifest address carries its own ? or & (a signed or tokenised URL), and it is not percent-encoded, so the link is cut short at the first one and the device fetches a truncated address. Percent-encode the whole url value.",
      });
    } else {
      checks.push({
        status: "warn",
        label: "The url value is not percent-encoded",
        detail:
          "A plain https path works unencoded, but the moment the address gains a reserved character the link breaks. Percent-encoding the whole url value is correct in both cases, so do it unconditionally.",
      });
    }
  } else if (looksEncoded) {
    checks.push({
      status: "pass",
      label: "The url value is percent-encoded",
      detail: "Good. This is what keeps a signed or tokenised manifest URL from breaking the link.",
    });
  }

  // 8. HTML-escaped ampersand.
  if (/&amp;/i.test(link)) {
    checks.push({
      status: "info",
      label: "This is the HTML-escaped form of the link",
      detail:
        "The &amp; is correct inside an href in a web page. When you paste the link straight into Safari, the ampersand should be a plain & instead.",
    });
  }

  return checks;
}

function hasKeyString(xml: string, key: string): boolean {
  // <key>bundle-identifier</key> followed (allowing whitespace) by a <string>…</string>.
  const re = new RegExp(
    `<key>\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</key>\\s*<string>`,
    "i",
  );
  return re.test(xml);
}

function analyzeManifest(input: string): Check[] {
  const checks: Check[] = [];
  const xml = input.trim();

  if (!/<plist|<dict/i.test(xml)) {
    checks.push({
      status: "warn",
      label: "This does not look like a property list",
      detail:
        "A manifest is XML that opens with <plist> and holds a <dict>. If you meant to check an install link, paste the itms-services:// link instead.",
    });
  }

  // software-package asset.
  if (/<string>\s*software-package\s*<\/string>/i.test(xml)) {
    checks.push({
      status: "pass",
      label: "A software-package asset is present",
      detail: "This is the entry that carries the .ipa URL, and the one asset a manifest cannot omit.",
    });
  } else {
    checks.push({
      status: "fail",
      label: "No software-package asset",
      detail:
        "The manifest needs one asset of kind software-package whose url is the .ipa. Without it the device has nothing to download.",
    });
  }

  // http anywhere in a URL value.
  if (/<string>\s*http:\/\//i.test(xml)) {
    checks.push({
      status: "fail",
      label: "A URL in the manifest is plain HTTP",
      detail:
        "Every url in the manifest, the .ipa and any artwork, has to be HTTPS on a trusted certificate. A plain http address stops the install with no message.",
    });
  }

  // The metadata keys the device reads before it shows the prompt.
  const metaChecks: { key: string; label: string }[] = [
    { key: "bundle-identifier", label: "bundle-identifier" },
    { key: "bundle-version", label: "bundle-version" },
    { key: "title", label: "title" },
  ];
  for (const { key, label } of metaChecks) {
    if (hasKeyString(xml, key)) {
      checks.push({
        status: "pass",
        label: `metadata has ${label}`,
        detail: "The device reads this before the transfer finishes, to name the app in the install prompt.",
      });
    } else {
      checks.push({
        status: key === "bundle-identifier" ? "fail" : "warn",
        label: `metadata is missing ${label}`,
        detail:
          key === "bundle-identifier"
            ? "Without the real bundle-identifier the device cannot tell whether this is a new app or a replacement, and it installs beside an existing copy or refuses outright."
            : "This is used in the install prompt. A manifest without it can still install but shows less to the tester.",
      });
    }
  }

  // metadata kind should be software.
  if (/<key>\s*kind\s*<\/key>\s*<string>\s*software\s*<\/string>/i.test(xml)) {
    checks.push({
      status: "pass",
      label: "metadata kind is software",
      detail: "The fixed value for an iOS app, and unrelated to the asset kind two levels up.",
    });
  }

  // A software-package url that points at a .plist is inverted.
  if (/<key>\s*kind\s*<\/key>\s*<string>\s*software-package\s*<\/string>[\s\S]{0,200}?\.plist\s*<\/string>/i.test(xml)) {
    checks.push({
      status: "warn",
      label: "The software-package URL looks like a .plist",
      detail:
        "The software-package asset should point at the .ipa, not at a plist. Check that the manifest and the build have not been swapped.",
    });
  }

  return checks;
}

export function analyzeOtaInput(input: string): OtaAnalysis {
  const text = (input ?? "").trim();
  if (text.length === 0) {
    return { kind: "unknown", checks: [], cannotCheck: CANNOT_CHECK };
  }

  const isLink = /itms-services:\/\//i.test(text) || /^https?:\/\//i.test(text) || /action=download-manifest/i.test(text);
  const isManifest = /<plist|<dict|software-package|<key>/i.test(text);

  if (isLink && !isManifest) {
    return { kind: "link", checks: analyzeLink(text), cannotCheck: CANNOT_CHECK };
  }
  if (isManifest) {
    return { kind: "manifest", checks: analyzeManifest(text), cannotCheck: CANNOT_CHECK };
  }

  return {
    kind: "unknown",
    checks: [
      {
        status: "warn",
        label: "This is neither an install link nor a manifest",
        detail:
          "Paste either the itms-services:// link (it starts itms-services://?action=download-manifest&url=…) or the XML of your manifest.plist, and this will check the shape of it.",
      },
    ],
    cannotCheck: CANNOT_CHECK,
  };
}
