import { globalScene } from "#app/global-scene";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import { isCapacitor, isElectron } from "#system/offline/backup-provider";
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
// "Download & Install" hint); the rest replace the footer entirely while the
// in-Electron self-updater (configs/desktop/electron/updater.cjs) runs.
type UpdateDownloadState = "idle" | "downloading" | "ready" | "applying" | "error";

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
  private downloadProgressText = "";
  private downloadErrorText = "";

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
    this.getUi().bringToTop(this.container);
    this.container.setVisible(true);
    this.renderPage();

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
    this.bodyText.setText(markdownToBBCode(release.changelog));

    this.refreshFooter();

    this.scrollY = 0;
    this.contentHeight = this.bodyText.displayHeight;
    this.applyScrollY();

    this.scrollBar.setTotalRows(Math.max(this.contentHeight, BODY_H));
    this.scrollBar.setScrollCursor(0);
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
        case "downloading":
          this.footerText.setText(`Downloading… ${this.downloadProgressText}   Cancel: Abort`);
          return;
        case "ready":
          this.footerText.setText("Enter: Restart & Install   Cancel: Later");
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
      hints.push("Enter: Download & Install");
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

  /** Kicks off downloadUpdate() and tracks progress/outcome via downloadState. */
  private startDownload(): void {
    this.downloadState = "downloading";
    this.downloadProgressText = "0%";
    this.refreshFooter();

    window.pkrOffline?.onUpdateProgress(({ received, total }) => {
      if (this.downloadState !== "downloading") {
        return;
      }
      this.downloadProgressText = total > 0 ? `${Math.floor((received / total) * 100)}%` : `${Math.floor(received / 1024)} KB`;
      this.refreshFooter();
    });

    window.pkrOffline
      ?.downloadUpdate()
      .then(() => {
        this.downloadState = "ready";
        this.refreshFooter();
      })
      .catch((err: unknown) => {
        this.downloadState = "error";
        this.downloadErrorText = err instanceof Error ? err.message : "Update download failed.";
        this.refreshFooter();
      });
  }

  /** Swaps the verified download into place and relaunches — only valid once downloadState is "ready". */
  private applyUpdate(): void {
    this.downloadState = "applying";
    this.refreshFooter();

    window.pkrOffline?.applyUpdateAndRelaunch().catch((err: unknown) => {
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
          window.pkrOffline?.cancelDownload();
          this.downloadState = "idle";
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
