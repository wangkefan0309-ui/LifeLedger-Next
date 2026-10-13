import { Buffer } from 'node:buffer';
import { requireThat } from '../core/ledger';

export const MAX_IMAGES = 5, MAX_IMAGE_BYTES = 8 * 1024 * 1024, MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export interface ScreenshotImage { id: string; dataUrl: string; bytes: number; accountId: string }
export interface ScreenshotOptions { date: string; onlySelectedDate: boolean; onlyExpenses: boolean }
export function inlineScreenshot(id: string, bytes: Uint8Array, accountId = ''): ScreenshotImage {
  requireThat(bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES, '每张截图需小于等于 8 MB');
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const mime = starts(137, 80, 78, 71, 13, 10, 26, 10) ? 'image/png' : starts(255, 216, 255) ? 'image/jpeg' : starts(82, 73, 70, 70) && [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte) ? 'image/webp' : '';
  requireThat(mime, '请选择 PNG、JPEG 或 WebP 截图；文件内容需为图片');
  return { id, bytes: bytes.length, accountId, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
}
export function validateScreenshots(images: ScreenshotImage[]) {
  requireThat(images.length > 0 && images.length <= MAX_IMAGES, '一次请选择 1 至 5 张截图');
  requireThat(new Set(images.map(image => image.id)).size === images.length, '截图标识重复，请重新选择');
  requireThat(images.reduce((total, image) => total + image.bytes, 0) <= MAX_TOTAL_IMAGE_BYTES, '截图总大小请控制在 20 MB 以内');
  for (const image of images) {
    requireThat(/^[\w-]+$/.test(image.id) && typeof image.accountId === 'string' && Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= MAX_IMAGE_BYTES, '截图信息无效，请重新选择');
    const match = image.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z\d+/]+={0,2})$/);
    requireThat(match && match[2].length <= Math.ceil(MAX_IMAGE_BYTES / 3) * 4, '截图编码无效，请重新选择');
    const decoded = Buffer.from(match[2], 'base64');
    requireThat(decoded.length === image.bytes && inlineScreenshot(image.id, decoded).dataUrl === image.dataUrl, '截图内容和格式不一致，请重新选择');
  }
}
