/**
 * The manifest.plist and the itms-services:// link that /manifest-plist-generator/ writes. The
 * text used to be built inside ManifestPlistGeneratorClient; it moved here so the BetaDrop MCP
 * server writes the same file from the same code. The page's behaviour is unchanged.
 *
 * Nothing here fetches, resolves or stores the URLs it is given: they are written into a plist
 * and into a link, nothing more (see the page component for why that matters).
 *
 * Deliberately dependency-free: no `@/` imports, no npm imports, no React.
 */

export interface ManifestAssets {
  ipaUrl: string;
  displayImageUrl: string;
  fullSizeImageUrl: string;
}

/** XML text escaping. Values come from an Info.plist and from typed URLs, both of which can
 *  legitimately contain & and <, and either would produce a plist iOS refuses to parse. */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** iOS installs over the air only from https:// URLs. */
export function isHttpsUrl(value: string): boolean {
  return /^https:\/\/\S+$/i.test(value.trim());
}

function assetBlock(kind: string, url: string): string {
  return [
      "        <dict>",
      "          <key>kind</key>",
      `          <string>${kind}</string>`,
      "          <key>url</key>",
      `          <string>${esc(url.trim())}</string>`,
      "        </dict>",
  ].join("\n");
}

export function buildManifestPlist(
  assets: ManifestAssets,
  bundleId: string,
  bundleVersion: string,
  title: string,
): string {
  const assetDicts = [assetBlock("software-package", assets.ipaUrl)];
  if (assets.displayImageUrl.trim()) {
    assetDicts.push(assetBlock("display-image", assets.displayImageUrl));
  }
  if (assets.fullSizeImageUrl.trim()) {
    assetDicts.push(assetBlock("full-size-image", assets.fullSizeImageUrl));
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>items</key>",
    "  <array>",
    "    <dict>",
    "      <key>assets</key>",
    "      <array>",
    assetDicts.join("\n"),
    "      </array>",
    "      <key>metadata</key>",
    "      <dict>",
    "        <key>bundle-identifier</key>",
    `        <string>${esc(bundleId.trim())}</string>`,
    "        <key>bundle-version</key>",
    `        <string>${esc(bundleVersion.trim())}</string>`,
    "        <key>kind</key>",
    "        <string>software</string>",
    "        <key>title</key>",
    `        <string>${esc(title.trim())}</string>`,
    "      </dict>",
    "    </dict>",
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * The install link for a hosted manifest. The manifest URL is a query-string VALUE, so every
 * reserved character in it (?, &, =, and the :// itself) has to be percent-encoded or the link
 * truncates at the first & and iOS asks for a manifest that does not exist.
 */
export function itmsServicesLink(manifestUrl: string): string {
  return manifestUrl.trim()
    ? `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl.trim())}`
    : "";
}
