/**
 * Google's 16 KB page size rules, as the checker page and the report view quote them.
 *
 * Every string here was copied from Google's pages on 2026-11-24:
 * - https://developer.android.com/guide/practices/page-sizes
 * - https://developer.android.com/google/play/requirements/target-sdk
 * When Google changes a date, a version or a flag, change it here and both the page and the
 * report follow. Nothing in this file is from memory.
 *
 * A plain module (no "use client"), so the server-rendered page and the client report view can
 * both import real values from it.
 */

export const GOOGLE_PAGE_SIZES_URL = "https://developer.android.com/guide/practices/page-sizes";
export const GOOGLE_TARGET_SDK_URL = "https://developer.android.com/google/play/requirements/target-sdk";
export const RULES_CHECKED_ON = "November 24, 2026";

/** As Google writes it. */
export const PLAY_DEADLINE = "February 1, 2027";

/** Google's own sentences, quoted on the page. */
export const PLAY_REQUIREMENT_QUOTE =
  "To ensure your app works correctly on the latest versions of Android, all apps targeting Android 15 (API level 35) and higher must support 16 KB memory page sizes on 64-bit devices on Google Play. Starting February 1, 2027, if your app updates don't support 16 KB memory page sizes, you won't be able to release these updates.";

/** From the target SDK page, as Google writes the date (no comma). */
export const TARGET_API_DATE = "August 31 2026";

/** Versions Google names as the fix. */
export const NDK_FIXED = "r28";
export const NDK_FLAGS_UP_TO = "r27";
export const NDK_LIBCXX_UP_TO = "r26";
export const AGP_FIXED = "8.5.1";

// The snippets as Google prints them, line breaks included.
// ${CMAKE_PROJECT_NAME} is CMake syntax, so it is built from two pieces to keep it out of JS's hands.
export const CMAKE_FLAGS = [
  "target_link_options(${" + "CMAKE_PROJECT_NAME} PRIVATE",
  '    "-Wl,-z,max-page-size=16384"',
  '    "-Wl,-z,common-page-size=16384"',
  ")",
].join("\n");
export const NDK_BUILD_FLAGS = "LOCAL_LDFLAGS += -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384";
export const LINKER_FLAGS = ["-Wl,-z,max-page-size=16384", "-Wl,-z,common-page-size=16384"] as const;
/** The block Google shows inside `android { }` for build.gradle (Groovy). */
export const LEGACY_PACKAGING = `packagingOptions {
    jniLibs {
        useLegacyPackaging true
    }
}`;
/** The one line that differs in build.gradle.kts (Kotlin), as Google shows it. */
export const LEGACY_PACKAGING_KOTLIN_LINE = "useLegacyPackaging = true";
export const LEGACY_PACKAGING_PROPERTY = "android.bundle.enableUncompressedNativeLibs=false";

// The commands Google gives for checking a build by hand.
export const CMD_ZIPALIGN = "zipalign -v -c -P 16 4 APK_NAME.apk";
export const CMD_OBJDUMP = "llvm-objdump -p SHARED_OBJECT_FILE.so | grep LOAD";
export const CMD_READELF = "llvm-readelf -Wl SHARED_OBJECT_FILE.so | grep 'LOAD\\|RELRO\\|Type'";
export const CMD_BUNDLETOOL = "bundletool dump config --bundle=<my .aab> | grep alignment";
