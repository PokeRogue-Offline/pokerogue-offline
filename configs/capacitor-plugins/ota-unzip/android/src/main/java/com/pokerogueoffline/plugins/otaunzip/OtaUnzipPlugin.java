package com.pokerogueoffline.plugins.otaunzip;

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
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Native (non-JS, non-WebView) OTA-bundle unzip. Exists specifically to avoid
 * routing the downloaded zip's bytes through the WebView/JS bridge at all -
 * see new-files/src/system/offline/mobile-updater.ts's doc comment on
 * stageAndActivateOta() for why that was suspected to be crashing the
 * WKWebView content process on iOS (this Android half of the fix is done for
 * parity/consistency, not because Android showed the same symptom).
 *
 * java.util.zip.ZipInputStream is part of the JDK - no third-party unzip
 * dependency needed on this platform.
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

        try {
            File sourceFile = resolveFile(sourcePath);
            File destDir = resolveFile(destDirPath);
            int entryCount = unzipToDir(sourceFile, destDir);
            JSObject result = new JSObject();
            result.put("entryCount", entryCount);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("OTA unzip failed: " + e.getMessage(), e);
        }
    }

    /**
     * Streams every entry straight from the zip's compressed data to its
     * destination file - ZipInputStream.read() returns only as much
     * decompressed data as fits in BUFFER_SIZE per call, and each chunk is
     * written out and discarded before the next read, so neither a single
     * entry nor the whole archive is ever held in memory at once.
     *
     * Strips exactly one leading path segment from every entry name (this
     * OTA zip's own `dist/` wrapper - build-android.yml/build-ios.yml's
     * `zip -r ota.zip dist` zips the "dist" directory itself, not just what's
     * inside it) so destDir's own root directly contains index.html -
     * matches the stripping streamingUnzipToDir() used to do in JS.
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
