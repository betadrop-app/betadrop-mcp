/**
 * Google's Android developer verification, asked the way the website's checker asks it: the
 * package name and the signing certificate's SHA-256 go to BetaDrop's public
 * `POST /api/tools/android-registration`, which asks Google's Developer ID Status API. No token
 * and no file: only those two values leave the machine.
 *
 * The reading of the answer and the sentences about it are the website's own
 * (web/src/lib/androidVerification), so the connector, the build badge and the checker page agree.
 */
import { apiBaseUrl } from "./api.js";
import { getClientAddress } from "./config.js";
import { checkerBlockingSentence, parseCheckResponse } from "@/lib/androidVerification/status";
import type { CheckOutcome } from "@/lib/androidVerification/status";
import { formatIsoDate, normalizeCertSha256 } from "@/lib/androidVerification/format";
import {
  FREE_ACCOUNT_DEVICES,
  FULL_ACCOUNT_FEE,
  GOOGLE_VERIFICATION_URL,
} from "@/lib/androidVerification/facts";

export type RegistrationOutcome = CheckOutcome | { kind: "network" };

/** Ask BetaDrop (and through it Google) whether this package and key are registered. Never throws. */
export async function lookupRegistration(packageName: string, certSha256: string): Promise<RegistrationOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  // Over HTTP the API sees every connector user as loopback; the limit is per address (see api.ts).
  const clientAddress = getClientAddress();
  if (clientAddress) headers["X-Forwarded-For"] = clientAddress;
  try {
    const response = await fetch(`${await apiBaseUrl()}/api/tools/android-registration`, {
      method: "POST",
      headers,
      body: JSON.stringify({ package: packageName.trim(), cert_sha256: normalizeCertSha256(certSha256) }),
      signal: AbortSignal.timeout(20_000),
    });
    const body: unknown = await response.json().catch(() => null);
    return parseCheckResponse(response.status, body);
  } catch {
    return { kind: "network" };
  }
}

const REGISTER_HOW =
  `Registering takes a free account (up to ${FREE_ACCOUNT_DEVICES} devices, enough for most beta tests) or a full one ` +
  `(${FULL_ACCOUNT_FEE} once, with ID), and the package name and SHA-256 entered in the Android Developer Console: ${GOOGLE_VERIFICATION_URL}`;

/**
 * The outcome as one report line: its mark and its sentence. The `ok`/`warning`/`error` levels
 * match the install-link checks, so `betadrop_inspect` can list it with them.
 */
export function registrationLine(outcome: RegistrationOutcome): { level: "ok" | "warning"; message: string } {
  if (outcome.kind === "result") {
    const checked = formatIsoDate(outcome.checkedAt);
    const when = checked ? ` (checked with Google on ${checked})` : "";
    switch (outcome.status) {
      case "registered":
        return {
          level: "ok",
          message: `Registered with Google${when}: Android keeps installing it from links like BetaDrop's while it is signed with this key.`,
        };
      case "not_registered":
        return {
          level: "warning",
          message: `Not registered with Google${when}. ${checkerBlockingSentence(outcome.allSourcesFrom)} ${REGISTER_HOW}`,
        };
      case "registered_other_key":
        return {
          level: "warning",
          message:
            `Registered with Google under a different signing key${when}, so Android treats builds signed with this key as unregistered. ` +
            `Builds signed with the registered key are fine, or this key's SHA-256 can be added to the app's registration in the Android Developer Console: ${GOOGLE_VERIFICATION_URL}`,
        };
    }
  }
  switch (outcome.kind) {
    case "not_available":
      return {
        level: "warning",
        message: `Google registration status isn't available right now. Google asks for the package name and SHA-256 shown here. ${REGISTER_HOW}`,
      };
    case "rate_limited":
      return { level: "warning", message: "Google registration not checked: too many checks from this network in the last hour." };
    case "invalid_package":
      return { level: "warning", message: "Google registration not checked: Google doesn't accept that package name." };
    case "invalid_cert":
    case "invalid":
      return { level: "warning", message: "Google registration not checked: the package name or SHA-256 was refused." };
    case "network":
      return { level: "warning", message: "Google registration not checked: BetaDrop could not be reached." };
    default:
      return { level: "warning", message: "Google registration not checked: the check didn't go through." };
  }
}
