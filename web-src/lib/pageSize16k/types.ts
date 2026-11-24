/**
 * The shape of a 16 KB page size check, shared by the engine (this folder) and everything that
 * shows a result: the checker page, and the APK and AAB inspectors.
 *
 * The engine reports facts only. Wording, colours and fix advice live in the view
 * (components/utilities/PageSizeReportView.tsx), so the two can change independently.
 *
 * The rules are Google's, from https://developer.android.com/guide/practices/page-sizes:
 * every 64-bit shared library must have 16 KB ELF segment alignment, an uncompressed library must
 * sit on a 16 KB boundary inside the APK, and the end of a GNU_RELRO segment that is followed by
 * writable data in the same LOAD segment must be 16 KB aligned.
 */

/** 16 KB in bytes: the page size the checks are made against. */
export const PAGE_16K = 16384;

/** What was dropped. An .aar is a library package (jni/<abi>/*.so); a .so is one bare library. */
export type PageSizeInputKind = "apk" | "aab" | "aar" | "so";

/** Why a file could not be checked at all. */
export type PageSizeRefusalReason =
  /** Not an APK, AAB, AAR or .so: an .ipa, a split-APK set (.apks, .xapk, .apkm), any other file. */
  | "unsupported_type"
  /** Looks like the right type but cannot be read: a damaged zip, or a .so that is not ELF. */
  | "corrupt"
  /** The browser lacks what the reader needs (DecompressionStream). */
  | "browser";

export interface PageSizeRefusal {
  ok: false;
  reason: PageSizeRefusalReason;
  /** A split-APK set, an .ipa and so on, when the type could be told: lets the view say what to do. */
  detected?: "ipa" | "apk_set" | "other";
}

/**
 * ELF check: every PT_LOAD segment's p_align must be a power of two of at least 16 KB, and the
 * segment must really be laid out that way (its address and file offset agree modulo 16 KB).
 */
export type ElfStatus =
  | "aligned"
  | "unaligned"
  /** The entry is named .so but is not an ELF file (some apps ship data under that name). */
  | "not_elf"
  /** ELF, but the program headers could not be read (truncated or damaged). */
  | "unreadable";

/** Where the library's bytes start inside the APK. Only an uncompressed entry has to be aligned. */
export type ZipStatus =
  | "aligned"
  | "unaligned"
  /** Stored compressed: Android extracts it at install, so its place in the zip does not matter. */
  | "compressed"
  /** Not an APK entry (an .aab, .aar or bare .so), so there is no APK offset to check. */
  | "not_applicable";

/**
 * RELRO check, Google's three compliant cases folded into `ok` and `none`.
 *
 * The rule is the reason Google gives, not the equality its page prints: on a 16 KB device the
 * Android linker makes every page GNU_RELRO touches read-only (bionic linker_phdr.cpp:
 * `page_end(p_vaddr + p_memsz)`), so a library breaks when something writable lives between the
 * RELRO end and the next 16 KB boundary. Real libraries often have RELRO ending slightly past its
 * own LOAD segment (the linker rounds its size up to 4 KB); those are fine.
 */
export type RelroStatus =
  /** No GNU_RELRO segment. Compliant. */
  | "none"
  /** GNU_RELRO ends on a 16 KB boundary, or no writable LOAD segment has data between its end and the next 16 KB boundary. */
  | "ok"
  /** GNU_RELRO ends off a 16 KB boundary and a writable LOAD segment has data between that end and the next 16 KB boundary. */
  | "misaligned"
  /** Could not be decided (the ELF headers were unreadable). */
  | "unknown";

export type LibraryProblem = "elf" | "zip" | "relro";

export interface LibraryCheck {
  /** Path inside the archive ("lib/arm64-v8a/libapp.so", "base/lib/arm64-v8a/libapp.so"); the file name for a bare .so. */
  path: string;
  /** File name only: "libapp.so". */
  name: string;
  /** The ABI folder it sits in ("arm64-v8a", "x86_64", "armeabi-v7a", "x86", "riscv64"); for a bare .so, the ABI its ELF header implies; null when neither is known. */
  abi: string | null;
  /** AAB only: the module it belongs to ("base", or a feature module's name). */
  module?: string;
  /** From the ELF header when readable, else from the ABI folder. Only 64-bit libraries are subject to the rule. */
  is64Bit: boolean;
  /**
   * True when it sits where Android loads libraries from: lib/<abi>/ in an APK, <module>/lib/<abi>/
   * in an AAB, jni/<abi>/ in an AAR (always true for a bare .so). A .so anywhere else, for example
   * under assets/, is listed with its facts but can never fail the app on its own.
   */
  inLibFolder: boolean;
  /** Uncompressed size in bytes. */
  size: number;
  elf: {
    status: ElfStatus;
    /** The smallest p_align among PT_LOAD segments, in bytes (4096, 16384, 65536); null when not read. */
    minLoadAlign: number | null;
    /**
     * Set when the header claims 16 KB or more but a LOAD segment's address and file offset differ
     * modulo 16 KB, so it cannot be mapped on 16 KB pages. A linker never writes that; a header
     * edited by hand to pass a check does. `status` is then "unaligned".
     */
    offsetMismatch?: true;
  };
  zip: {
    status: ZipStatus;
    /** Offset of the entry's data from the start of the APK, when it is stored uncompressed. */
    dataOffset?: number;
  };
  relro: {
    status: RelroStatus;
    /** VirtAddr + MemSiz of GNU_RELRO, when there is one. */
    end?: number;
    /** VirtAddr + MemSiz of the LOAD segment that contains its start, when one does. */
    loadEnd?: number;
  };
  /**
   * The row's outcome.
   * - "pass": 64-bit and every applicable check passed.
   * - "fail": 64-bit and at least one check failed (see `problems`).
   * - "not_subject": a 32-bit library (the rule covers 64-bit devices), a .so outside the library
   *   folders (`inLibFolder` false), or a file named .so that is not ELF at all (`elf.status` is
   *   "not_elf": data shipped under a library name, which Google's own script skips). None of
   *   these can fail the app, with one exception: a not-ELF file stored uncompressed off a 16 KB
   *   boundary in a 64-bit library folder is a "fail" on zip, because `zipalign -P 16` judges
   *   every name ending in .so.
   * - "unreadable": an ELF file in a 64-bit library folder whose headers could not be read.
   */
  result: "pass" | "fail" | "not_subject" | "unreadable";
  /** Which checks failed. Decides the verdict only when `result` is "fail"; on a "not_subject" row it is information. */
  problems: LibraryProblem[];
}

export type PageSizeVerdict =
  /** There are 64-bit libraries and every one passes every check. */
  | "supported"
  /**
   * At least one 64-bit library fails a check; or, for an .aab with 64-bit libraries, the APKs
   * built from it will carry uncompressed libraries on 4 KB boundaries (flag `bundle_alignment_4k`
   * or `bundle_alignment_unspecified`), in which case `counts.failed` can be 0.
   */
  | "not_supported"
  /**
   * No shared library in a library folder. Google: "If no shared object files are present or there
   * is no `lib` folder, then your app doesn't use native code", and such an app "already supports
   * 16 KB devices". A .so that sits only outside the library folders does not change this (the
   * `so_outside_lib` flag says it is there).
   */
  | "no_native_code"
  /** There are .so files in the library folders, but none is a 64-bit library, so there is nothing the rule applies to. */
  | "no_64bit"
  /** No failure found, but at least one 64-bit library could not be read. */
  | "inconclusive";

/** What an .aab's BundleConfig.pb asks bundletool to do with native libraries. */
export interface BundleNativeConfig {
  /** optimizations.uncompress_native_libraries.enabled as written; null when the message is absent. */
  uncompressNativeLibs: boolean | null;
  /** optimizations.uncompress_native_libraries.alignment as written. */
  alignment: "16k" | "4k" | "64k" | "unspecified";
  /** bundletool.version from the config, when present ("1.17.2"): the bundletool that built the bundle. */
  bundletoolVersion: string | null;
  /**
   * What bundletool then does, from its own source (OptimizationsMerger.mergeWithDefaults,
   * ApkOptimizations' defaults by version, ApkSerializerModule; read at release 1.18.3):
   * - libraries are stored uncompressed unless the config's message says `enabled: false`
   *   (the default has been "uncompressed" since bundletool 0.6.0);
   * - an alignment the config does not name defaults to 16 KB for a bundle built by bundletool
   *   1.17.0 or newer, and to 4 KB for one built by an older bundletool. With no version
   *   recorded, bundletool uses its own current version, so that counts as 16 KB.
   */
  effectiveUncompressed: boolean;
  effectiveAlignment: "16k" | "4k" | "64k";
}

/** Facts about the file that change what the view should say. Each appears at most once. */
export type PageSizeFlag =
  /** An APK that is one piece of a split set (its manifest has a `split` attribute, or it declares required splits): the libraries may be in another piece. */
  | "split_apk"
  /** Uncompressed 32-bit libraries are not 16 KB zip-aligned: `zipalign -c -P 16` prints "Verification FAILED" although no 64-bit library is affected. */
  | "zipalign_would_fail_32bit_only"
  /** .so files exist outside the library folders (for example under assets/). They are listed but Android does not load them itself. */
  | "so_outside_lib"
  /**
   * An .aab whose config asks for 4 KB-aligned, uncompressed .so files in the APKs built from it
   * (`bundle.alignment` is "4k" and `bundle.effectiveUncompressed` is true). Google: "16 KB devices
   * require apps that ship with uncompressed shared libraries to align them on a 16 KB zip-aligned
   * boundary." Set only when the bundle has a 64-bit library in a library folder, and then it alone
   * makes the verdict "not_supported".
   */
  | "bundle_alignment_4k"
  /**
   * An .aab that names no alignment and was built by a bundletool older than 1.17.0, so the APKs
   * built from it get uncompressed libraries on 4 KB boundaries (`bundle.alignment` is
   * "unspecified", `bundle.effectiveAlignment` is "4k", `bundle.effectiveUncompressed` is true).
   * Same effect on the verdict as `bundle_alignment_4k`. Not set when the default is 16 KB.
   */
  | "bundle_alignment_unspecified"
  /** targetSdk is below 35: the Play rule is written for apps targeting API 35 or higher. */
  | "target_below_35";

export interface PageSizeReport {
  ok: true;
  kind: PageSizeInputKind;
  fileName: string;
  fileSize: number;
  verdict: PageSizeVerdict;
  /** android:targetSdkVersion, when the manifest could be read (APK and AAB). */
  targetSdk: number | null;
  /** The manifest's package name, when readable. Shown only; never sent anywhere. */
  packageName: string | null;
  /** android:extractNativeLibs from <application>, when the manifest states it. */
  extractNativeLibs: boolean | null;
  /** Every .so found, 64-bit failures first, then by path. */
  libraries: LibraryCheck[];
  counts: {
    /** All .so files found. */
    total: number;
    /** Rows the rule applies to: every row whose `result` is not "not_subject". */
    subject: number;
    passed: number;
    failed: number;
    /** Of the failed ones, how many fail each check (a library can fail several). */
    elfFailed: number;
    zipFailed: number;
    relroFailed: number;
    /** 32-bit libraries, .so files outside the library folders, and not-ELF files named .so. */
    notSubject: number;
    unreadable: number;
  };
  /** AAB only. */
  bundle?: BundleNativeConfig;
  flags: PageSizeFlag[];
}

export type PageSizeResult = PageSizeReport | PageSizeRefusal;
