import { decoder } from "../../shared/bytes";

export interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Uint8Array;
}

/**
 * JS baseline multipart/form-data parser (byte-safe via Buffer.indexOf),
 * mirroring the shape of `rust.multipartParse`.
 */
export function nativeMultipartParse(
  body: Uint8Array,
  boundary: Uint8Array,
): MultipartPart[] {
  const buf = Buffer.from(body);
  const delim = Buffer.from(`--${decoder.decode(boundary)}`);

  const result: MultipartPart[] = [];

  // Body must begin with the opening delimiter.
  if (buf.indexOf(delim) !== 0) return result;

  let pos = delim.length;

  while (pos <= buf.length) {
    // Closing delimiter (`--{boundary}--`).
    if (buf.subarray(pos, pos + 2).toString() === "--") break;
    // Expect `\r\n` then the part.
    if (buf.subarray(pos, pos + 2).toString() !== "\r\n") break;
    pos += 2;

    const headerEnd = buf.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1) break;
    const headerBlock = buf.subarray(pos, headerEnd).toString();
    pos = headerEnd + 4;

    const next = buf.indexOf(delim, pos);
    if (next === -1) break;

    let data = buf.subarray(pos, next);
    // Strip the trailing `\r\n` that precedes the next delimiter.
    if (
      data.length >= 2 &&
      data.subarray(data.length - 2).toString() === "\r\n"
    ) {
      data = data.subarray(0, data.length - 2);
    }

    let name = "";
    let filename: string | null = null;
    let contentType: string | null = null;

    for (const line of headerBlock.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const field = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();

      if (field.toLowerCase() === "content-disposition") {
        const nameMatch = /name="([^"]*)"/.exec(value);
        if (nameMatch) name = nameMatch[1] ?? "";
        const fileMatch = /filename="([^"]*)"/.exec(value);
        if (fileMatch) filename = fileMatch[1] ?? null;
      } else if (field.toLowerCase() === "content-type") {
        contentType = value;
      }
    }

    result.push({
      name,
      filename,
      contentType,
      data: new Uint8Array(data),
    });

    pos = next + delim.length;
  }

  return result;
}
