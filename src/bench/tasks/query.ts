import * as native from '../../baseline'
import { rust } from '../../rust-ffi'
import { pairsToObject, readPairsPacked } from '../../shared/packed'
import type { BenchFixtures } from '../fixtures'
import type { BenchTask } from '../types'

export function queryTasks(f: BenchFixtures): BenchTask[] {
  return [
    {
      name: 'native:query_parse',
      run: () => native.nativeQueryParsePacked(f.queryStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'rust:query_parse',
      run: () => rust.queryParsePacked(f.queryStr).byteLength,
      iterations: 500,
      warmup: 50,
    },
    {
      name: 'native:query_parse_pipeline',
      run: () => {
        const obj = pairsToObject(readPairsPacked(native.nativeQueryParsePacked(f.queryStr)))
        return Object.keys(obj).length
      },
      iterations: 300,
      warmup: 30,
    },
    {
      name: 'rust:query_parse_pipeline',
      run: () => {
        const obj = pairsToObject(readPairsPacked(rust.queryParsePacked(f.queryStr)))
        return Object.keys(obj).length
      },
      iterations: 300,
      warmup: 30,
    },
  ]
}
