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
