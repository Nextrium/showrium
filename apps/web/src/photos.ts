// Photos from phones: iPhones save HEIC by default, and the server (and the AI that reads photos)
// takes JPEG, PNG or WebP. So HEIC is converted to JPEG here, in the browser, before upload.
// Very large photos are scaled down too, which keeps uploads fast on mobile data.

const MAX_SIDE = 2560;
const REENCODE_OVER = 4 * 1024 * 1024;

async function headerBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 16).arrayBuffer());
}

/** HEIC/HEIF by type, name or the file's own bytes (an ISO-BMFF "ftyp" box with a HEIF brand). */
export async function isHeic(file: File): Promise<boolean> {
  if (/^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name)) return true;
  const b = await headerBytes(file);
  const box = String.fromCharCode(...b.slice(4, 8));
  const brand = String.fromCharCode(...b.slice(8, 12));
  return box === "ftyp" && ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand);
}

function jpegName(name: string): string {
  return `${(name || "photo").replace(/\.[a-z0-9]+$/i, "")}.jpg`;
}

async function drawToJpeg(source: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  // JPEG has no transparency: see-through areas become white, not black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.88));
}

/**
 * Returns a file the server accepts. HEIC → JPEG (natively where the browser can decode it,
 * as Safari does; otherwise with a converter loaded only when needed). Big photos → scaled JPEG.
 * Anything else is returned unchanged.
 */
export async function preparePhoto(file: File): Promise<File> {
  if (await isHeic(file)) {
    let jpeg: Blob;
    try {
      jpeg = await drawToJpeg(await createImageBitmap(file));
    } catch {
      try {
        const { heicTo } = await import("heic-to/csp");
        jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.88 });
        if (jpeg.size > REENCODE_OVER) jpeg = await drawToJpeg(await createImageBitmap(jpeg));
      } catch {
        throw new Error("We couldn't convert this iPhone photo. Try sharing it as JPG (Photos → Share → Options → Most Compatible).");
      }
    }
    return new File([jpeg], jpegName(file.name), { type: "image/jpeg" });
  }
  if (/^image\/(jpeg|png|webp)$/i.test(file.type) && file.size > REENCODE_OVER) {
    try {
      return new File([await drawToJpeg(await createImageBitmap(file))], jpegName(file.name), { type: "image/jpeg" });
    } catch {
      return file; // The server still takes it if it's under 10 MB.
    }
  }
  return file;
}

/**
 * For post images: every platform takes JPG and PNG, but LinkedIn doesn't take WebP. So a WebP
 * (or a photo that needed converting) becomes a JPEG; JPG, PNG and GIF are kept as they are.
 */
export async function prepareForPosting(file: File): Promise<File> {
  const prepared = await preparePhoto(file);
  if (!/^image\/webp$/i.test(prepared.type)) return prepared;
  try {
    return new File([await drawToJpeg(await createImageBitmap(prepared))], jpegName(prepared.name), { type: "image/jpeg" });
  } catch {
    return prepared;
  }
}
