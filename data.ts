const encoder = new TextEncoder();

export function jsonRowsBytes(rows: number): Uint8Array {
  const data = Array.from({ length: rows }, (_, i) => ({
    id: i,
    name: `user_${i}`,
    active: i % 2 === 0,
    score: i * 1.25,
    tags: ["alpha", "beta", "gamma"],
    nested: {
      version: i % 10,
      createdAt: "2026-01-01T00:00:00Z",
    },
  }));

  return encoder.encode(JSON.stringify(data));
}

export function productAddBytes(name = "widget"): Uint8Array {
  return encoder.encode(JSON.stringify({ name }));
}

export function productIdBytes(id = "123"): Uint8Array {
  return encoder.encode(id);
}

export function batchBytes(ops: number): Uint8Array {
  const data = Array.from({ length: ops }, (_, i) => {
    if (i % 2 === 0) {
      return {
        id: String(i),
        op: "products.add",
        body: {
          name: `item_${i}`,
        },
      };
    }

    return {
      id: String(i),
      op: "products.get",
      params: {
        id: `id_${i}`,
      },
    };
  });

  return encoder.encode(JSON.stringify(data));
}

export function urlBytes(count: number): Uint8Array {
  const urls = Array.from(
    { length: count },
    (_, i) =>
      `https://sub${i % 255}.example.com:8080/api/v1/items/${i}?q=${encodeURIComponent(
        `user ${i}`,
      )}&page=${i % 50}#section-${i}`,
  );

  return encoder.encode(urls.join("\n"));
}

export function hashBytes(size: number): Uint8Array {
  const base = "Bun Rust FFI runtime benchmark payload. ";
  const repeated = base.repeat(Math.ceil(size / base.length));
  return encoder.encode(repeated.slice(0, size));
}

export function taskBytes(events: number): Uint8Array {
  const data = {
    events: Array.from({ length: events }, (_, i) => ({
      id: i,
      kind: `event_${i % 25}`,
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        index: i,
        value: `value_${i}`,
      },
    })),
  };

  return encoder.encode(JSON.stringify(data));
}