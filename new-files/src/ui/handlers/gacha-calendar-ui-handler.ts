import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { getLegendaryGachaSpeciesForTimestamp } from "#data/egg";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import { UiHandler } from "#ui/ui-handler";
import { addTextObject } from "#ui/text";
import { addWindow } from "#ui/ui-theme";

/**
 * Offline-only "Gacha Calendar" screen.
 *
 * Purely informational: shows which species is boosted in the Legendary
 * gacha on any given day, for the currently displayed month. Reuses the
 * REAL {@linkcode getLegendaryGachaSpeciesForTimestamp} export from
 * `#data/egg` for every single day shown — no reimplementation of the
 * seeded RNG or the day/cycle math happens in this file. That function
 * already treats its input as a plain UTC-day timestamp (it divides by
 * 86400000 with no timezone adjustment), so every date this screen
 * constructs is built with `Date.UTC(...)` and rendered using the `getUTC*`
 * accessors. Never local time - that would silently shift which "day"
 * a given cell actually represents relative to what the real Egg Gacha
 * screen shows for "today".
 */

const DAY_MS = 86400000;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const COLUMNS = 7;
const ROWS = 6;
const CELL_W = 44;
const CELL_H = 20;
const GRID_X = 4;

// Layout budget against the real 320x180 canvas (see scene-base.ts
// scaledCanvas). Each section gets its own fixed band so nothing overlaps:
//   Header (title):     0-22   (tall enough for WINDOW-style text + shadow)
//   Weekday row:        23-33
//   Day grid:           34-153 (6 rows x 20px)
//   Footer (today/tmrw):156-178 (single line each, side by side)
const HEADER_H = 22;
const WEEKDAY_Y = HEADER_H + 1;
const GRID_Y = WEEKDAY_Y + 11;
const FOOTER_Y = GRID_Y + ROWS * CELL_H + 2;
const FOOTER_H = 22;

interface DayCell {
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.NineSlice;
  dateText: Phaser.GameObjects.Text;
  icon: Phaser.GameObjects.Sprite;
  /** UTC-midnight timestamp for the day this cell is currently showing, or null if blank */
  timestamp: number | null;
}

/** Returns the UTC-midnight timestamp for the given UTC year/month(0-11)/day */
function utcMidnight(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day);
}

/** Number of days in a given UTC year/month (month is 0-11) */
function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export class GachaCalendarUiHandler extends UiHandler {
  private calendarContainer: Phaser.GameObjects.Container;

  private titleText: Phaser.GameObjects.Text;
  private weekdayTexts: Phaser.GameObjects.Text[];
  private cells: DayCell[];
  private cursorObj: Phaser.GameObjects.Image;

  private todayLabel: Phaser.GameObjects.Text;
  private todayIcon: Phaser.GameObjects.Sprite;
  private tomorrowLabel: Phaser.GameObjects.Text;
  private tomorrowIcon: Phaser.GameObjects.Sprite;

  /** Currently displayed UTC year/month (month is 0-11) */
  private viewYear: number;
  private viewMonth: number;

  /** Index (0-based, into the visible day cells only) of the cursor */
  private dayCursor: number;

  setup(): void {
    const ui = this.getUi();

    this.calendarContainer = globalScene.add
      .container(0, -globalScene.scaledCanvas.height)
      .setVisible(false);
    ui.add(this.calendarContainer);

    const bgColor = globalScene.add
      .rectangle(0, 0, globalScene.scaledCanvas.width, globalScene.scaledCanvas.height, 0x006860)
      .setOrigin(0);
    this.calendarContainer.add(bgColor);

    // Header window with title text (month/year, filled in on show/navigate)
    const headerWindow = addWindow(0, 0, globalScene.scaledCanvas.width, HEADER_H).setOrigin(0);
    this.calendarContainer.add(headerWindow);

    this.titleText = addTextObject(2, 3, "", TextStyle.WINDOW, { maxLines: 1 }).setOrigin(0);
    this.calendarContainer.add(this.titleText);

    // Weekday header row - sits below the header window, not on top of it.
    this.weekdayTexts = [];
    for (let c = 0; c < COLUMNS; c++) {
      const t = addTextObject(GRID_X + c * CELL_W, WEEKDAY_Y, WEEKDAY_LABELS[c], TextStyle.WINDOW_ALT, {
        maxLines: 1,
      }).setOrigin(0);
      this.calendarContainer.add(t);
      this.weekdayTexts.push(t);
    }

    // Day grid
    this.cells = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLUMNS; c++) {
        const x = GRID_X + c * CELL_W;
        const y = GRID_Y + r * CELL_H;

        const cellContainer = globalScene.add.container(x, y);

        const bg = addWindow(0, 0, CELL_W - 2, CELL_H - 2).setOrigin(0);
        cellContainer.add(bg);

        const dateText = addTextObject(2, 1, "", TextStyle.WINDOW, { maxLines: 1 }).setOrigin(0);
        cellContainer.add(dateText);

        // Icon anchored toward the bottom-right, clear of the date number
        // in the top-left corner.
        const icon = globalScene.add.sprite(34, 10, "pokemon_icons_0").setScale(0.45).setOrigin(0.5);
        cellContainer.add(icon);

        this.calendarContainer.add(cellContainer);

        this.cells.push({ container: cellContainer, bg, dateText, icon, timestamp: null });
      }
    }

    this.cursorObj = globalScene.add.image(0, 0, "select_cursor").setOrigin(0);
    this.calendarContainer.add(this.cursorObj);

    // Today / tomorrow summary footer - single line each, side by side.
    const footerWindow = addWindow(0, FOOTER_Y, globalScene.scaledCanvas.width, FOOTER_H).setOrigin(0);
    this.calendarContainer.add(footerWindow);

    this.todayIcon = globalScene.add.sprite(10, FOOTER_Y + 11, "pokemon_icons_0").setScale(0.5);
    this.calendarContainer.add(this.todayIcon);
    this.todayLabel = addTextObject(20, FOOTER_Y + 3, "", TextStyle.WINDOW, { maxLines: 1 }).setOrigin(0);
    this.calendarContainer.add(this.todayLabel);

    this.tomorrowIcon = globalScene.add
      .sprite(globalScene.scaledCanvas.width / 2 + 10, FOOTER_Y + 11, "pokemon_icons_0")
      .setScale(0.5);
    this.calendarContainer.add(this.tomorrowIcon);
    this.tomorrowLabel = addTextObject(globalScene.scaledCanvas.width / 2 + 20, FOOTER_Y + 3, "", TextStyle.WINDOW, {
      maxLines: 1,
    }).setOrigin(0);
    this.calendarContainer.add(this.tomorrowLabel);
  }

  override show(args: any[]): boolean {
    super.show(args);

    const now = new Date();
    this.viewYear = now.getUTCFullYear();
    this.viewMonth = now.getUTCMonth();
    this.dayCursor = now.getUTCDate() - 1;

    this.getUi().bringToTop(this.calendarContainer);
    this.calendarContainer.setVisible(true);

    this.renderMonth();
    this.updateTodayTomorrow();
    this.setCursor(this.dayCursor);

    return true;
  }

  /** Rebuilds the visible grid for `this.viewYear` / `this.viewMonth`, entirely in UTC. */
  private renderMonth(): void {
    this.titleText.setText(`${MONTH_LABELS[this.viewMonth]} ${this.viewYear}`);

    const firstOfMonth = utcMidnight(this.viewYear, this.viewMonth, 1);
    const startWeekday = new Date(firstOfMonth).getUTCDay(); // 0 = Sunday
    const totalDays = daysInUtcMonth(this.viewYear, this.viewMonth);

    const todayTimestamp = utcMidnight(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    );

    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      const dayOfMonth = i - startWeekday + 1;

      if (dayOfMonth < 1 || dayOfMonth > totalDays) {
        cell.container.setVisible(false);
        cell.timestamp = null;
        continue;
      }

      cell.container.setVisible(true);
      const timestamp = utcMidnight(this.viewYear, this.viewMonth, dayOfMonth);
      cell.timestamp = timestamp;

      cell.dateText.setText(`${dayOfMonth}`);

      const species = speciesDataRegistry.getSpecies(getLegendaryGachaSpeciesForTimestamp(timestamp));
      cell.icon.setTexture(species.getIconAtlasKey(), species.getIconId(false));

      cell.bg.setAlpha(timestamp === todayTimestamp ? 1 : 0.7);
    }
  }

  private updateTodayTomorrow(): void {
    const now = new Date();
    const todayTimestamp = utcMidnight(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const tomorrowTimestamp = todayTimestamp + DAY_MS;

    const todaySpecies = speciesDataRegistry.getSpecies(getLegendaryGachaSpeciesForTimestamp(todayTimestamp));
    const tomorrowSpecies = speciesDataRegistry.getSpecies(getLegendaryGachaSpeciesForTimestamp(tomorrowTimestamp));

    this.todayLabel.setText(`Today: ${todaySpecies.getName()}`);
    this.todayIcon.setTexture(todaySpecies.getIconAtlasKey(), todaySpecies.getIconId(false));

    this.tomorrowLabel.setText(`Tomorrow: ${tomorrowSpecies.getName()}`);
    this.tomorrowIcon.setTexture(tomorrowSpecies.getIconAtlasKey(), tomorrowSpecies.getIconId(false));
  }

  private goToMonth(deltaMonths: number): void {
    let newMonth = this.viewMonth + deltaMonths;
    let newYear = this.viewYear;
    while (newMonth < 0) {
      newMonth += 12;
      newYear--;
    }
    while (newMonth > 11) {
      newMonth -= 12;
      newYear++;
    }
    this.viewYear = newYear;
    this.viewMonth = newMonth;

    // Keep the cursor on the same day-of-month where possible, clamped to the new month's length.
    const currentDayOfMonth = this.currentCellDayOfMonth() ?? 1;
    const clampedDay = Math.min(currentDayOfMonth, daysInUtcMonth(this.viewYear, this.viewMonth));
    const firstOfMonth = utcMidnight(this.viewYear, this.viewMonth, 1);
    const startWeekday = new Date(firstOfMonth).getUTCDay();
    this.dayCursor = startWeekday + clampedDay - 1;

    this.renderMonth();
    this.setCursor(this.dayCursor);
  }

  private currentCellDayOfMonth(): number | null {
    const cell = this.cells[this.dayCursor];
    if (!cell || cell.timestamp === null) {
      return null;
    }
    return new Date(cell.timestamp).getUTCDate();
  }

  processInput(button: Button): boolean {
    const ui = this.getUi();
    let success = false;

    switch (button) {
      case Button.CANCEL:
        ui.revertMode();
        success = true;
        break;
      case Button.LEFT:
        success = this.moveCursor(-1);
        break;
      case Button.RIGHT:
        success = this.moveCursor(1);
        break;
      case Button.UP:
        success = this.moveCursor(-COLUMNS);
        break;
      case Button.DOWN:
        success = this.moveCursor(COLUMNS);
        break;
      case Button.CYCLE_SHINY:
        this.goToMonth(-1);
        success = true;
        break;
      case Button.CYCLE_FORM:
        this.goToMonth(1);
        success = true;
        break;
      default:
        break;
    }

    if (success) {
      ui.playSelect();
    }

    return success;
  }

  /** Moves the cursor by `delta` cells, rolling over into the previous/next month at the edges. */
  private moveCursor(delta: number): boolean {
    let target = this.dayCursor + delta;

    if (target < 0 || target >= this.cells.length || this.cells[target]?.timestamp === null) {
      // Walked off the visible month (or into a blank leading/trailing cell) - jump month instead.
      this.goToMonth(delta > 0 ? 1 : -1);
      return true;
    }

    this.dayCursor = target;
    this.setCursor(this.dayCursor);
    return true;
  }

  override setCursor(cursor: number): boolean {
    const changed = super.setCursor(cursor);

    const cell = this.cells[cursor];
    if (cell?.container.visible) {
      this.cursorObj.setPosition(cell.container.x - 1, cell.container.y - 1);
      this.cursorObj.setVisible(true);
    } else {
      this.cursorObj.setVisible(false);
    }

    return changed;
  }

  override clear(): void {
    super.clear();
    this.calendarContainer.setVisible(false);
  }
}
