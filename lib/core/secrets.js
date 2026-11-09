/**
 * Secret storage for SSH passwords/passphrases.
 *
 * Secrets live in a private JSON document, encrypted with AES-256-GCM using a
 * per-installation random key (0600) generated on first use. The DSH
 * credentials service is the long-term home for these values; until that
 * contract is verified on the desktop runtime this self-contained store keeps
 * plaintext off disk without blocking the plugin.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { readTextFile, secretsKeyPath, secretsPath, writePrivateFile } from './paths.js'

const ALGO = 'aes-256-gcm'
const PREFIX = 'enc:v1:'

function loadKey(file = secretsKeyPath()) {
  const text = readTextFile(file).trim()
  if (text) {
    const key = Buffer.from(text, 'base64')
    if (key.length === 32) return key
  }
  const key = randomBytes(32)
  writePrivateFile(file, `${key.toString('base64')}\n`)
  return key
}

function readDoc(file) {
  const text = readTextFile(file)
  if (!text.trim()) return { version: 1, entries: {} }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return parsed
    }
  } catch {
    // corrupt document: fall through to an empty one rather than crashing boot
  }
  return { version: 1, entries: {} }
}

function encrypt(plain, key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, data]).toString('base64')
}

function decrypt(token, key) {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) return undefined
  const payload = Buffer.from(token.slice(PREFIX.length), 'base64')
  if (payload.length <= 28) return undefined
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(12, 28)
  const data = payload.subarray(28)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function createSecretStore({ file = secretsPath(), keyFile = secretsKeyPath() } = {}) {
  let key
  const keyOf = () => {
    if (!key) key = loadKey(keyFile)
    return key
  }
  return {
    get(recordKey) {
      const doc = readDoc(file)
      const token = doc.entries[recordKey]
      if (token === undefined) return undefined
      try {
        return decrypt(token, keyOf())
      } catch {
        return undefined
      }
    },
    has(recordKey) {
      const doc = readDoc(file)
      return doc.entries[recordKey] !== undefined
    },
    set(recordKey, value) {
      const doc = readDoc(file)
      doc.entries[recordKey] = encrypt(value, keyOf())
      writePrivateFile(file, `${JSON.stringify(doc, null, 2)}\n`)
    },
    delete(recordKey) {
      const doc = readDoc(file)
      if (doc.entries[recordKey] === undefined) return false
      delete doc.entries[recordKey]
      writePrivateFile(file, `${JSON.stringify(doc, null, 2)}\n`)
      return true
    },
  }
}
