// src/baseline/tasks/mime.ts — JS baseline: MIME-type lookup.

import mime from 'mime-types'

export function nativeMimeFromExtension(ext: string): string {
  return mime.lookup(ext) || 'application/octet-stream'
}
