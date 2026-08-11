// src/ingress/routes/delete.ts — Pre-baked DELETE handler.

import { readHandler } from "./read";

/**
 * Pre-baked DELETE handler: DELETE is a read-style method (no request body is
 * read), so it shares the exact pipeline flow of {@link readHandler} — it
 * returns the ingress body JSON on success and the terminal/error responses
 * otherwise. Reusing the read factory keeps the two handlers byte-identical
 * and avoids a copy-pasted variant.
 *
 * Wire it via the `delete` key of a `BakedRoute` (see `createIngressServer`).
 */
export const deleteHandler = readHandler;
