package xyz.scooom.pkr;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

// Manually-registered native plugin (not an npm package - see MainActivity's
// registerPlugin(OtaBridgePlugin.class) call) backing
// new-files/src/system/offline/mobile-updater.ts's Android OTA/native-fallback
// paths. Stock Capacitor plugins expose neither of these:
//   - setBasePath: re-points the WebView at a staged OTA web bundle directory,
//     via Bridge's own public setServerBasePath(String) API.
//   - installApk: hands a downloaded APK to Android's system package
//     installer. This is a *hand-off*, not an install - the OS, not this
//     plugin, does the installing, which is why the JS/UI side describes it
//     as "opening the installer" rather than "installing".
@CapacitorPlugin(name = "OtaBridge")
public class OtaBridgePlugin extends Plugin {

    @PluginMethod
    public void setBasePath(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("Missing 'path'");
            return;
        }
        getBridge().setServerBasePath(path);
        call.resolve();
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null) {
            call.reject("Missing 'path'");
            return;
        }

        Context context = getContext();
        Uri apkUri = FileProvider.getUriForFile(
            context,
            context.getPackageName() + ".fileprovider",
            new File(path)
        );

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        context.startActivity(intent);
        call.resolve();
    }
}
