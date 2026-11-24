import { changedRegions, SCREEN, type DrawOp, type FontSize, type Region, type ScreenModel } from "../layout";

export const SCALE = 2;

/** CSS font size per bitmap font, chosen so a monospace glyph matches the cell width. */
const FONT_PX: Record<FontSize, number> = { small: 10, medium: 13, large: 26 };

/** Draws layout models on a 2x canvas, repainting only regions that changed. */
export class LcdRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private prev: ScreenModel | null = null;
  redraws = 0;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    ctx.scale(SCALE, SCALE);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, SCREEN, SCREEN);
  }

  private off: HTMLCanvasElement | null = null;
  private lastPixels = "";

  /**
   * Protocol version 4: the screen is an RGB565 framebuffer drawn pixel by pixel (v4/screen.ts). It is blitted 1:1
   * and scaled up with smoothing off; an unchanged frame is skipped, like the firmware's dirty boxes.
   */
  renderPixels(rgba: Uint8ClampedArray, key: string): void {
    this.prev = null;
    if (key === this.lastPixels) return;
    this.lastPixels = key;
    if (!this.off) {
      this.off = document.createElement("canvas");
      this.off.width = SCREEN;
      this.off.height = SCREEN;
    }
    const octx = this.off.getContext("2d");
    if (!octx) return;
    octx.putImageData(new ImageData(new Uint8ClampedArray(rgba), SCREEN, SCREEN), 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(this.off, 0, 0);
    this.redraws++;
  }

  render(model: ScreenModel): void {
    this.lastPixels = "";
    const changed = changedRegions(this.prev, model);
    const hadOverlay = this.prev?.regions.some((r) => r.id === "overlay") ?? false;
    const hasOverlay = model.regions.some((r) => r.id === "overlay");
    this.prev = model;
    if (changed.length === 0) return;
    this.redraws++;
    // The overlay dims everything beneath it, so any change under it repaints the frame.
    const full = hasOverlay || hadOverlay;
    if (full) {
      // Also clears the gaps between regions, which the banner may have covered.
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, SCREEN, SCREEN);
    }
    for (const region of model.regions) {
      if (full || changed.includes(region.id)) this.paint(region, region.id !== "overlay");
    }
  }

  private paint(region: Region, clear: boolean): void {
    const { ctx } = this;
    if (clear) {
      ctx.fillStyle = "#000";
      ctx.fillRect(region.rect.x, region.rect.y, region.rect.w, region.rect.h);
    }
    for (const op of region.ops) this.draw(op);
  }

  private draw(op: DrawOp): void {
    const { ctx } = this;
    switch (op.t) {
      case "fill":
        ctx.fillStyle = op.color;
        ctx.fillRect(op.x, op.y, op.w, op.h);
        return;
      case "outline":
        ctx.strokeStyle = op.color;
        ctx.lineWidth = op.width;
        ctx.strokeRect(op.x + op.width / 2, op.y + op.width / 2, op.w - op.width, op.h - op.width);
        return;
      case "line":
        ctx.strokeStyle = op.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(op.x1 + 0.5, op.y1 + 0.5);
        ctx.lineTo(op.x2 + 0.5, op.y2 + 0.5);
        ctx.stroke();
        return;
      case "text":
        ctx.fillStyle = op.color;
        ctx.font = `${FONT_PX[op.font]}px ui-monospace, Menlo, monospace`;
        ctx.textBaseline = "top";
        ctx.textAlign = op.align;
        ctx.fillText(op.text, op.x, op.y);
        return;
      case "dim":
        ctx.fillStyle = op.color;
        ctx.fillRect(0, 0, SCREEN, SCREEN);
        return;
    }
  }
}
