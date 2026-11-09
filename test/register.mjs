// test-only module resolution stubs
import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)
