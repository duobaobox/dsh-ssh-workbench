// test-only ssh2 resolution for the local SSH transport integration test
import { register } from 'node:module'

register('./ssh2-loader.mjs', import.meta.url)
