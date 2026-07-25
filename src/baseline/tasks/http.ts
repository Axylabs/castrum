import { decoder, encoder } from "../../shared/bytes";

export function nativeHttpParseRequest(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const headerEnd = text.indexOf("\r\n\r\n");
  const head = headerEnd >= 0 ? text.slice(0, headerEnd) : text;

  const lines = head.split("\r\n");
  const requestLine = lines[0] ?? "";
  const [method = "", target = "", version = ""] = requestLine.split(" ");

  const headers = new Headers();

  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const name = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      headers.append(name, value);
    }
  }

  let path = target;
  try {
    const url = new URL(target, "http://internal");
    path = url.pathname + url.search;
  } catch {
    // Keep raw target when it is not a parseable URL.
  }

  return encoder.encode(
    JSON.stringify({
      method,
      path,
      version,
      headers: Object.fromEntries(headers.entries()),
    }),
  );
}

export function nativeHttpParseRequestPacked(bytes: Uint8Array): Uint8Array {
  const text = decoder.decode(bytes);
  const headerEnd = text.indexOf("\r\n\r\n");
  const head = headerEnd >= 0 ? text.slice(0, headerEnd) : text;

  const lines = head.split("\r\n");
  const requestLine = lines[0] ?? "";
  const [method = "", target = "", version = ""] = requestLine.split(" ");

  const methodBytes = encoder.encode(method);
  const pathBytes = encoder.encode(target);
  const versionBytes = encoder.encode(version);

  const headers: Array<[Uint8Array, Uint8Array]> = [];

  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const name = encoder.encode(line.slice(0, idx).trim().toLowerCase());
      const value = encoder.encode(line.slice(idx + 1).trim());
      headers.push([name, value]);
    }
  }

  let total = 16;
  total += methodBytes.byteLength;
  total += pathBytes.byteLength;
  total += versionBytes.byteLength;

  for (const [name, value] of headers) {
    total += 8 + name.byteLength + value.byteLength;
  }

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let offset = 0;

  const writeBytes = (bytes: Uint8Array) => {
    dv.setUint32(offset, bytes.byteLength, true);
    offset += 4;
    out.set(bytes, offset);
    offset += bytes.byteLength;
  };

  writeBytes(methodBytes);
  writeBytes(pathBytes);
  writeBytes(versionBytes);

  dv.setUint32(offset, headers.length, true);
  offset += 4;

  for (const [name, value] of headers) {
    writeBytes(name);
    writeBytes(value);
  }

  return out;
}