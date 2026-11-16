package com.pokerogueoffline.plugins.otaunzip;

import android.os.StatFs;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

/**
 * Native (non-JS, non-WebView) OTA-bundle unzip. Exists specifically to avoid
 * routing the downloaded zip's bytes through the WebView/JS bridge at all -
 * see new-files/src/system/offline/mobile-updater.ts's doc comment on
 * downloadToFile() for why that was suspected to be crashing the
 * WKWebView content process on iOS (this Android half of the fix is done for
 * parity/consistency, not because Android showed the same symptom).
 *
 * java.util.zip is part of the JDK - no third-party unzip dependency needed
 * on this platform.
 *
 * Truncation guard: the downloaded zip is deliberately NOT checksummed
 * (hashing 500MB+ through the WebView is what this plugin exists to
 * avoid), so a download cut short has to be caught structurally instead.
 * Three cheap checks, none of which reads the archive into memory:
 *   1. the file's size must equal `expectedBytes` (when given);
 *   2. the zip's central directory - which sits at the very END of the
 *      file - must be readable, which a truncated file's is not;
 *   3. the number of files extracted must equal `expectedEntries` (when
 *      given) and the central directory's own file count.
 * Check 3 matters on its own: ZipInputStream reads local headers from the
 * front and simply reports "no more entries" when a file ends exactly on
 * an entry boundary, without any error.
 */
@CapacitorPlugin(name = "OtaUnzip")
public class OtaUnzipPlugin extends Plugin {

    private static final int BUFFER_SIZE = 64 * 1024;

    /**
     * Resolves a path that may be a file:// URI (as returned by Capacitor's
     * own Filesystem.getUri(), which is what mobile-updater.ts passes in) or
     * a plain filesystem path, to a real java.io.File. new File(String) does
     * NOT correctly handle a "file://..." string (it would treat the literal
     * scheme text as part of the path), so a URI must go through
     * new File(URI) instead.
     */
    private static File resolveFile(String pathOrUri) throws URISyntaxException {
        if (pathOrUri.startsWith("file:")) {
            return new File(new URI(pathOrUri));
        }
        return new File(pathOrUri);
    }

    @PluginMethod
    public void unzip(PluginCall call) {
        String sourcePath = call.getString("sourcePath");
        String destDirPath = call.getString("destDir");
        if (sourcePath == null) {
            call.reject("Missing 'sourcePath'");
            return;
        }
        if (destDirPath == null) {
            call.reject("Missing 'destDir'");
            return;
        }

        // optLong() rather than getInt()/getLong(): the bridge hands a JS
        // number over as Integer, Long or Double depending on its size.
        long expectedBytes = call.getData().has("expectedBytes") ? call.getData().optLong("expectedBytes", -1) : -1;
        long expectedEntries = call.getData().has("expectedEntries") ? call.getData().optLong("expectedEntries", -1) : -1;

        try {
            File sourceFile = resolveFile(sourcePath);
            File destDir = resolveFile(destDirPath);

            if (expectedBytes >= 0 && sourceFile.length() != expectedBytes) {
                throw new IOException(
                    "Downloaded file is " + sourceFile.length() + " bytes, expected " + expectedBytes + " - the download is incomplete."
                );
            }
            int listedFiles = countFileEntries(sourceFile);
            if (expectedEntries >= 0 && listedFiles != expectedEntries) {
                throw new IOException("Archive lists " + listedFiles + " files, expected " + expectedEntries + ".");
            }

            int entryCount = unzipToDir(sourceFile, destDir);
            if (entryCount != listedFiles) {
                throw new IOException("Extracted " + entryCount + " files, but the archive lists " + listedFiles + " - the archive is damaged.");
            }

            JSObject result = new JSObject();
            result.put("entryCount", entryCount);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("OTA unzip failed: " + e.getMessage(), e);
        }
    }

    /**
     * Reports the bytes available to this app on the volume that holds its
     * private data. Used only for a local "will this update fit" check
     * before downloading; the value is never stored or sent anywhere.
     */
    @PluginMethod
    public void freeSpace(PluginCall call) {
        try {
            StatFs stat = new StatFs(getContext().getFilesDir().getPath());
            JSObject result = new JSObject();
            result.put("bytes", stat.getAvailableBytes());
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not determine free space: " + e.getMessage(), e);
        }
    }

    /**
     * Counts the file (non-directory) entries listed in the archive's
     * central directory, applying the same filtering unzipToDir() does.
     * Opening the archive this way reads only the central directory, and
     * throws for a file whose end has been cut off.
     */
    private static int countFileEntries(File sourceFile) throws IOException {
        int count = 0;
        try (ZipFile zip = new ZipFile(sourceFile)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry entry = entries.nextElement();
                if (!entry.isDirectory() && !stripLeadingSegment(entry.getName()).isEmpty()) {
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Streams every entry straight from the zip's compressed data to its
     * destination file - ZipInputStream.read() returns only as much
     * decompressed data as fits in BUFFER_SIZE per call, and each chunk is
     * written out and discarded before the next read, so neither a single
     * entry nor the whole archive is ever held in memory at once.
     *
     * Strips exactly one leading path segment from every entry name (each
     * OTA zip wraps its content in one top-level directory - see
     * scripts/split-ota-bundle.js) so destDir's own root directly contains
     * the channel's entries.
     */
    private static int unzipToDir(File sourceFile, File destDir) throws IOException {
        int entryCount = 0;
        byte[] buffer = new byte[BUFFER_SIZE];

        try (InputStream rawIn = new FileInputStream(sourceFile); ZipInputStream zipIn = new ZipInputStream(rawIn)) {
            ZipEntry entry;
            while ((entry = zipIn.getNextEntry()) != null) {
                if (entry.isDirectory()) {
                    continue;
                }
                String relativeName = stripLeadingSegment(entry.getName());
                if (relativeName.isEmpty()) {
                    continue;
                }

                File outFile = new File(destDir, relativeName);
                if (!outFile.getCanonicalPath().startsWith(destDir.getCanonicalPath() + File.separator)) {
                    // Zip-slip guard: an entry name that escapes destDir (e.g. "../../etc/passwd")
                    // is malformed/malicious - this OTA source is our own release asset, but there's
                    // no reason not to guard it anyway.
                    throw new IOException("Zip entry escapes destination directory: " + entry.getName());
                }

                File parent = outFile.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("Could not create directory: " + parent);
                }

                try (OutputStream out = new FileOutputStream(outFile)) {
                    int read;
                    while ((read = zipIn.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                    }
                }
                entryCount++;
            }
        }

        return entryCount;
    }

    private static String stripLeadingSegment(String entryName) {
        int slashIndex = entryName.indexOf('/');
        return slashIndex == -1 ? entryName : entryName.substring(slashIndex + 1);
    }
}
