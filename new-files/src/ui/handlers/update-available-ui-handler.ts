import { globalScene } from "#app/global-scene";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import { type DesktopOtaCheckResult, type DesktopOtaFile, isCapacitor, isElectron } from "#system/offline/backup-provider";
import { checkForMobileUpdate, type MobileUpdateCheckResult } from "#system/offline/mobile-updater";
import type { ReleaseInfo } from "#system/offline/update-check-api";
import { startMobileUpdateFlow } from "#ui/mobile-update-overlay";
import { ScrollBar } from "#ui/containers/scroll-bar";
import { addBBCodeTextObject, addTextObject } from "#ui/text";
import { UiHandler } from "#ui/ui-handler";
import { addWindow } from "#ui/ui-theme";
import { markdownToBBCode } from "#ui/utils/markdown-to-bbcode";
import type BBCodeText from "phaser3-rex-plugins/plugins/gameobjects/tagtext/bbcodetext/BBCodeText";

/**
 * Offline-only "Update Available" screen. Opened once per launch (from
 * title-ui-handler.ts's update checker) when one or more app versions newer
 * than the one currently installed exist. Left/Right page through each
 * missing version in ascending order; Up/Down scroll that version's
 * changelog text.
 */

// wordWrap/mask geometry use "true" font pixels, unaffected by the text
// object's own render scale - see the identical GLOBAL_SCALE convention in
// move-info-overlay.ts / pokedex-info-overlay.ts.
const GLOBAL_SCALE = 6;

const HEADER_H = 20;
const FOOTER_H = 20;
const BODY_Y = HEADER_H;
const BODY_H = 180 - BODY_Y - FOOTER_H;
const FOOTER_Y = BODY_Y + BODY_H;

const BODY_X = 4;
const SCROLLBAR_W = 4;
const SCROLLBAR_X = 320 - SCROLLBAR_W - 2;
const BODY_WIDTH_PX = SCROLLBAR_X - BODY_X - 4;

const SCROLL_STEP_PX = 16;

// Electron-only: "idle" shows the normal paging/scroll footer (plus a
// "Download & Install" hint); the rest replace the footer entirely while an
// update runs. "checking" is the moment before it is known which of the two
// desktop updaters applies to this release.
type UpdateDownloadState = "checking" | "idle" | "downloading" | "ready" | "applying" | "error";

/**
 * Which desktop updater handles this release:
 * - "ota": only the web content changed. The changed files (code, images
 *   and audio, translations) are downloaded and unpacked while the game
 *   keeps running, and take effect the next time it starts
 *   (configs/desktop/electron/ota-desktop.cjs).
 * - "binary": the application itself changed, so the whole executable is
 *   replaced (configs/desktop/electron/updater.cjs).
 */
type DesktopUpdatePath = "ota" | "binary";

/** One line of the download display: a file, how much of it has arrived, and its total size. */
interface DownloadRow {
  label: string;
  received: number;
  /** 0 while unknown. */
  total: number;
  /** Shown instead of the byte counts once the file is fully downloaded and being unpacked. */
  note?: string;
}

const OTA_FILE_LABELS: Record<DesktopOtaFile["id"], string> = {
  code: "Game code",
  assets: "Images & audio",
  locales: "Translations",
};

/** MB with one decimal, so both numbers of a row share a unit and a few MB of code doesn't read as "0". */
function formatMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function formatProgress(received: number, total: number): string {
  return total > 0 ? `${formatMb(Math.min(received, total))} / ${formatMb(total)} MB` : `${formatMb(received)} MB`;
}

export class UpdateAvailableUiHandler extends UiHandler {
  private container: Phaser.GameObjects.Container;
  private titleText: Phaser.GameObjects.Text;
  private pagerText: Phaser.GameObjects.Text;
  private footerText: Phaser.GameObjects.Text;
  private bodyText: BBCodeText;
  private scrollBar: ScrollBar;

  private releases: ReleaseInfo[] = [];
  private pageIndex = 0;

  private scrollY = 0;
  private contentHeight = 0;

  private downloadState: UpdateDownloadState = "idle";
  private downloadErrorText = "";
  private desktopUpdatePath: DesktopUpdatePath = "binary";
  private desktopOtaResult: Extract<DesktopOtaCheckResult, { kind: "ota" }> | null = null;
  /** What is being downloaded right now, one row per file - see renderDownloadBody(). */
  private downloadRows: DownloadRow[] = [];
  /** A line under the rows for work that isn't a file download (first-time preparation). */
  private downloadStatusLine = "";
  /** Bumped whenever a download starts or is abandoned, so a late result from an earlier one is ignored. */
  private downloadToken = 0;

  // Capacitor-only: populated asynchronously by show() via
  // checkForMobileUpdate(); null until that resolves, or forever on a
  // non-Capacitor platform, or when there's nothing actionable (iOS
  // native-touching releases - see mobile-updater.ts's "kind" field).
  // Once an update is actually started, the DOM overlay (#ui/mobile-update-
  // overlay) owns the rest of the flow entirely - this class just hands off.
  private mobileUpdateResult: MobileUpdateCheckResult | null = null;
  private mobileUpdateStarted = false;

  setup(): void {
    const ui = this.getUi();

    // Ui itself is positioned at (0, scaledCanvas.height) (see Ui's constructor), so any
    // container added directly via ui.add(...) must start at -scaledCanvas.height to land
    // back at world (0,0) - confirmed against AchvsUiHandler, a real shipped screen that's
    // also in noTransitionModes, which uses the exact same offset for the same reason.
    this.container = globalScene.add.container(0, -globalScene.scaledCanvas.height).setVisible(false);
    ui.add(this.container);

    const bg = globalScene.add
      .rectangle(0, 0, globalScene.scaledCanvas.width, globalScene.scaledCanvas.height, 0x006860)
      .setOrigin(0);
    this.container.add(bg);

    const headerWindow = addWindow(0, 0, globalScene.scaledCanvas.width, HEADER_H).setOrigin(0);
    this.container.add(headerWindow);

    this.titleText = addTextObject(4, 3, "Update Available", TextStyle.WINDOW, { maxLines: 1 }).setOrigin(0);
    this.container.add(this.titleText);

    this.pagerText = addTextObject(globalScene.scaledCanvas.width - 4, 3, "", TextStyle.WINDOW, {
      maxLines: 1,
    }).setOrigin(1, 0);
    this.container.add(this.pagerText);

    this.bodyText = addBBCodeTextObject(BODY_X, BODY_Y, "", TextStyle.WINDOW, {
      wordWrap: { width: BODY_WIDTH_PX * GLOBAL_SCALE },
    }).setOrigin(0);
    this.container.add(this.bodyText);

    // Clip the changelog text to the body band - geometry masks are drawn in
    // true pixels, then scaled up to match how the rest of this text-rendering
    // pipeline supersamples fonts (see GLOBAL_SCALE above).
    const bodyMaskRect = globalScene.make.graphics();
    bodyMaskRect.fillStyle(0xff0000);
    bodyMaskRect.fillRect(BODY_X, BODY_Y, BODY_WIDTH_PX, BODY_H);
    bodyMaskRect.setScale(GLOBAL_SCALE);
    this.bodyText.setMask(this.container.createGeometryMask(bodyMaskRect));

    this.scrollBar = new ScrollBar(SCROLLBAR_X, BODY_Y, SCROLLBAR_W, BODY_H, BODY_H);
    this.container.add(this.scrollBar);

    const footerWindow = addWindow(0, FOOTER_Y, globalScene.scaledCanvas.width, FOOTER_H).setOrigin(0);
    this.container.add(footerWindow);

    this.footerText = addTextObject(4, FOOTER_Y + 3, "", TextStyle.WINDOW, { maxLines: 1 }).setOrigin(0);
    this.container.add(this.footerText);
  }

  override show(args: any[]): boolean {
    super.show(args);

    this.releases = (args[0] as ReleaseInfo[]) ?? [];
    if (this.releases.length === 0) {
      return false;
    }

    this.pageIndex = 0;
    this.mobileUpdateResult = null;
    this.mobileUpdateStarted = false;
    this.downloadToken++;
    this.downloadState = "idle";
    this.downloadRows = [];
    this.downloadStatusLine = "";
    this.desktopUpdatePath = "binary";
    this.desktopOtaResult = null;
    this.getUi().bringToTop(this.container);
    this.container.setVisible(true);
    this.renderPage();

    // Electron-only: ask the main process whether this release can be
    // delivered as a content update or needs the whole application
    // replaced. Until that answers, Enter does nothing - starting the
    // (much larger) full download by default would be the wrong guess.
    const otaCheck = window.pkrOffline?.otaCheck;
    if (isElectron() && otaCheck && typeof args[1] === "string" && typeof args[2] === "number") {
      const token = this.downloadToken;
      this.downloadState = "checking";
      this.refreshFooter();
      otaCheck(args[1], args[2])
        .catch(() => null)
        .then(result => {
          if (token !== this.downloadToken || this.downloadState !== "checking") {
            return;
          }
          if (result?.kind === "ota") {
            this.desktopUpdatePath = "ota";
            this.desktopOtaResult = result;
            // Already downloaded during an earlier visit to this screen.
            this.downloadState = result.staged ? "ready" : "idle";
          } else {
            this.downloadState = "idle";
          }
          this.renderBody();
          this.refreshFooter();
        });
    }

    // Capacitor-only, independent of the changelog data above:
    // title-ui-handler.ts (patches/all/node/update-check.js) passes the
    // installed version/build number through as args[1]/args[2] for
    // exactly this - update-check-api.ts/checkForUpdates() itself stays
    // platform-agnostic and untouched.
    if (isCapacitor() && typeof args[1] === "string" && typeof args[2] === "number") {
      console.log(`[update-available-ui] show(): kicking off checkForMobileUpdate(${args[1]}, ${args[2]})`);
      checkForMobileUpdate(args[1], args[2]).then(result => {
        console.log(`[update-available-ui] checkForMobileUpdate resolved:`, result);
        this.mobileUpdateResult = result;
        this.refreshFooter();
        console.log(`[update-available-ui] mobileUpdateActionable() = ${this.mobileUpdateActionable()}`);
      });
    } else {
      console.log(
        `[update-available-ui] show(): skipping mobile update check (isCapacitor()=${isCapacitor()}, args[1]=${typeof args[1]}, args[2]=${typeof args[2]})`,
      );
    }

    return true;
  }

  /** Renders the current page's version/changelog and resets scroll, per spec. */
  private renderPage(): void {
    const release = this.releases[this.pageIndex];

    this.titleText.setText(`Update Available   v${release.version} (build ${release.buildNumber})`);
    this.pagerText.setText(this.releases.length > 1 ? `${this.pageIndex + 1} / ${this.releases.length}` : "");
    this.renderBody();
    this.refreshFooter();
  }

  /**
   * Fills the body band: normally the current page's changelog, but while
   * an update is downloading it is the per-file download display instead,
   * and once a content update is staged it says what happens next.
   */
  private renderBody(): void {
    let text: string;
    if (isElectron() && this.downloadState === "downloading") {
      text = this.downloadBodyText();
    } else if (isElectron() && this.downloadState === "ready" && this.desktopUpdatePath === "ota") {
      text =
        "The update has been downloaded.\n\n" +
        "It will be installed the next time the game starts. You can keep playing and restart later, or restart now.";
    } else {
      text = markdownToBBCode(this.releases[this.pageIndex].changelog);
    }
    this.bodyText.setText(text);

    this.scrollY = 0;
    this.contentHeight = this.bodyText.displayHeight;
    this.applyScrollY();

    this.scrollBar.setTotalRows(Math.max(this.contentHeight, BODY_H));
    this.scrollBar.setScrollCursor(0);
  }

  /** The download display: every file with its total size and how much of it has been downloaded, then the overall total. */
  private downloadBodyText(): string {
    const lines: string[] = ["Downloading update", ""];
    for (const row of this.downloadRows) {
      lines.push(`${row.label}:   ${row.note ?? formatProgress(row.received, row.total)}`);
    }
    if (this.downloadRows.length > 1) {
      lines.push("", `Total:   ${this.downloadTotalText()}`);
    }
    if (this.downloadStatusLine) {
      lines.push("", this.downloadStatusLine);
    }
    return lines.join("\n");
  }

  /** "12.3 / 540.1 MB" across all files; just the downloaded amount while any file's size is unknown. */
  private downloadTotalText(): string {
    const received = this.downloadRows.reduce((sum, row) => sum + row.received, 0);
    const allKnown = this.downloadRows.length > 0 && this.downloadRows.every(row => row.total > 0);
    return formatProgress(received, allKnown ? this.downloadRows.reduce((sum, row) => sum + row.total, 0) : 0);
  }

  /**
   * Builds the footer text for whatever's currently going on. Outside of
   * Electron (the web build), or while idle, this is just the normal
   * paging/scroll hints - everything else is the self-updater's own status,
   * which replaces those hints entirely since paging/scrolling don't apply
   * mid-download.
   */
  private refreshFooter(): void {
    if (isElectron()) {
      switch (this.downloadState) {
        case "checking":
          this.footerText.setText("Checking update…   Cancel: Close");
          return;
        case "downloading":
          this.footerText.setText(`Downloading… ${this.downloadTotalText()}   Cancel: Abort`);
          return;
        case "ready":
          this.footerText.setText(
            this.desktopUpdatePath === "ota" ? "Enter: Restart Now   Cancel: Later" : "Enter: Restart & Install   Cancel: Later",
          );
          return;
        case "applying":
          this.footerText.setText("Applying update…");
          return;
        case "error":
          this.footerText.setText(`${this.downloadErrorText}   Cancel: Close`);
          return;
        default:
          break;
      }
    }

    const hints: string[] = ["↑↓ Scroll"];
    if (this.releases.length > 1) {
      hints.push("◀▶ Version");
    }
    if (isElectron()) {
      // A content update says up front how much it will download.
      const otaBytes = this.desktopOtaResult?.files.reduce((sum, file) => sum + file.bytes, 0) ?? 0;
      hints.push(otaBytes > 0 ? `Enter: Download Update (${formatMb(otaBytes)} MB)` : "Enter: Download & Install");
    } else if (isCapacitor() && this.mobileUpdateActionable() && !this.mobileUpdateStarted) {
      hints.push("Enter: Download Update");
    }
    hints.push("Cancel: Close");
    this.footerText.setText(hints.join("   "));
  }

  /** True when there's something for Button.ACTION to do on Capacitor - false for null (not checked yet / nothing applicable) and for the iOS native-touching "notify only" kind. */
  private mobileUpdateActionable(): boolean {
    return this.mobileUpdateResult?.kind === "ota" || this.mobileUpdateResult?.kind === "native-android";
  }

  /** Starts whichever desktop download applies and tracks progress/outcome via downloadState. */
  private startDownload(): void {
    const bridge = window.pkrOffline;
    if (!bridge) {
      return;
    }
    const token = ++this.downloadToken;
    const isCurrent = () => token === this.downloadToken && this.downloadState === "downloading";
    const refresh = () => {
      this.bodyText.setText(this.downloadBodyText());
      this.refreshFooter();
    };

    this.downloadState = "downloading";
    this.downloadStatusLine = "";

    let download: Promise<unknown>;
    if (this.desktopUpdatePath === "ota" && this.desktopOtaResult && bridge.otaDownload) {
      // One row per file, each with its total size known before a single
      // byte has arrived.
      this.downloadRows = this.desktopOtaResult.files.map(file => ({ label: OTA_FILE_LABELS[file.id], received: 0, total: file.bytes }));
      bridge.onOtaProgress?.(progress => {
        if (!isCurrent()) {
          return;
        }
        if (progress.phase === "download") {
          const row = this.downloadRows[progress.index];
          if (row) {
            row.received = progress.received;
            if (progress.total > 0) {
              row.total = progress.total;
            }
          }
        } else if (progress.phase === "prepare") {
          this.downloadStatusLine = `Preparing game files:   ${formatProgress(progress.received, progress.total)}`;
        } else {
          this.downloadStatusLine = "";
          const row = this.downloadRows[progress.index];
          if (row) {
            row.received = row.total > 0 ? row.total : row.received;
            row.note = `${formatProgress(row.received, row.total)}   unpacking…`;
          }
        }
        refresh();
      });
      download = bridge.otaDownload();
    } else {
      this.downloadRows = [{ label: "Application", received: 0, total: 0 }];
      bridge.onUpdateProgress(({ received, total }) => {
        if (!isCurrent()) {
          return;
        }
        this.downloadRows[0].received = received;
        this.downloadRows[0].total = total;
        refresh();
      });
      download = bridge.downloadUpdate();
    }

    this.renderBody();
    this.refreshFooter();

    download
      .then(() => {
        if (!isCurrent()) {
          return;
        }
        this.downloadState = "ready";
        this.renderBody();
        this.refreshFooter();
      })
      .catch((err: unknown) => {
        if (!isCurrent()) {
          return; // cancelled by the user - already back to idle
        }
        this.downloadState = "error";
        this.downloadErrorText = err instanceof Error ? err.message : "Update download failed.";
        this.renderBody();
        this.refreshFooter();
      });
  }

  /**
   * Only valid once downloadState is "ready". Full-binary update: swaps the
   * verified download into place and relaunches. Content update: nothing
   * left to install now - it is applied when the game next starts - so this
   * just restarts it.
   */
  private applyUpdate(): void {
    this.downloadState = "applying";
    this.refreshFooter();

    const bridge = window.pkrOffline;
    const apply = this.desktopUpdatePath === "ota" && bridge?.otaRestart ? bridge.otaRestart() : bridge?.applyUpdateAndRelaunch();
    apply?.catch((err: unknown) => {
      this.downloadState = "error";
      this.downloadErrorText = err instanceof Error ? err.message : "Failed to apply update.";
      this.refreshFooter();
    });
  }

  processInput(button: Button): boolean {
    const ui = this.getUi();
    let success = false;

    switch (button) {
      case Button.CANCEL:
        if (this.downloadState === "downloading") {
          if (this.desktopUpdatePath === "ota") {
            window.pkrOffline?.otaCancel?.();
          } else {
            window.pkrOffline?.cancelDownload();
          }
          this.downloadToken++;
          this.downloadState = "idle";
          this.renderBody();
          this.refreshFooter();
          success = true;
          break;
        }
        ui.revertMode();
        success = true;
        break;
      case Button.ACTION:
        success = this.handleAction();
        break;
      case Button.LEFT:
        if (this.pageIndex > 0) {
          this.pageIndex--;
          this.renderPage();
          success = true;
        }
        break;
      case Button.RIGHT:
        if (this.pageIndex < this.releases.length - 1) {
          this.pageIndex++;
          this.renderPage();
          success = true;
        }
        break;
      case Button.UP:
        success = this.manualScroll(-SCROLL_STEP_PX);
        break;
      case Button.DOWN:
        success = this.manualScroll(SCROLL_STEP_PX);
        break;
      default:
        break;
    }

    if (success) {
      ui.playSelect();
    }

    return success;
  }

  /** Button.ACTION: starts a download when idle, or applies+relaunches once one is verified and ready. */
  private handleAction(): boolean {
    if (isElectron()) {
      switch (this.downloadState) {
        case "idle":
          this.startDownload();
          return true;
        case "ready":
          this.applyUpdate();
          return true;
        default:
          return false;
      }
    }

    if (isCapacitor() && this.mobileUpdateActionable() && !this.mobileUpdateStarted) {
      this.mobileUpdateStarted = true;
      startMobileUpdateFlow(this.mobileUpdateResult!);
      this.refreshFooter();
      return true;
    }

    return false;
  }

  private manualScroll(delta: number): boolean {
    const maxScroll = Math.max(0, this.contentHeight - BODY_H);
    if (maxScroll === 0) {
      return false;
    }

    const newScrollY = Phaser.Math.Clamp(this.scrollY + delta, 0, maxScroll);
    if (newScrollY === this.scrollY) {
      return false;
    }
    this.scrollY = newScrollY;
    this.applyScrollY();
    return true;
  }

  private applyScrollY(): void {
    this.bodyText.y = BODY_Y - this.scrollY;
    this.scrollBar.setScrollCursor(this.scrollY);
  }

  override clear(): void {
    super.clear();
    this.container.setVisible(false);
  }
}
