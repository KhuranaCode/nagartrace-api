import sharp from 'sharp';
import crypto from 'node:crypto';
import { HttpError } from './auth.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

function sniff(b: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

/** Validates by magic bytes (not the declared type), bounds the decode, re-encodes to JPEG and drops metadata.
 *  This is NOT face/number-plate redaction and NOT a malware scan. */
export async function normalizeImage(input: Buffer) {
  if (input.length === 0 || input.length > MAX_BYTES) throw new HttpError(413, 'Image empty or too large', 'bad_image');
  if (!sniff(input)) throw new HttpError(415, 'Only JPEG, PNG or WebP images are accepted', 'bad_image');
  try {
    const img = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) throw new Error('no dimensions');
    const out = await img.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return { data: out.data, width: out.info.width, height: out.info.height, sha256: crypto.createHash('sha256').update(out.data).digest('hex'), contentType: 'image/jpeg' };
  } catch {
    throw new HttpError(422, 'Image could not be decoded', 'bad_image');
  }
}
