/**
 * Per-session execution summary for the composer target dock.
 *
 * DSH owns conversation/model metrics (turns, TTFT, TPS); the plugin cannot
 * read them. This module only summarizes the activity entries the plugin
 * writes for remote executions, so the dock can show accurate SSH-side counts
 * and latency without inventing values it does not own.
 */

function numericDuration(entry) {
  return Number.isFinite(entry?.durationMs) && entry.durationMs >= 0 ? entry.durationMs : 0
}

function emptyBucket(name) {
  return { name, count: 0, success: 0, failed: 0, durationMs: 0, averageMs: 0, lastAt: null }
}

function addToBucket(bucket, entry) {
  bucket.count += 1
  if (entry.outcome === 'success') bucket.success += 1
  else bucket.failed += 1
  bucket.durationMs += numericDuration(entry)
  if (typeof entry.at === 'string' && (bucket.lastAt === null || entry.at > bucket.lastAt)) bucket.lastAt = entry.at
}

/**
 * Summarize the plugin's remote execution activity for one Session.
 *
 * @param {object[]} entries newest-first activity entries
 * @param {{ sessionId?: string, candidates?: string[] }} options
 * @returns {{
 *   sessionId: string|null,
 *   count: number,
 *   success: number,
 *   failed: number,
 *   durationMs: number,
 *   averageMs: number,
 *   lastAt: string|null,
 *   servers: Array<{name:string,count:number,success:number,failed:number,durationMs:number,averageMs:number,lastAt:string|null}>
 * }}
 */
export function summarizeExecution(entries, { sessionId, candidates = [] } = {}) {
  const wanted = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  const byServer = new Map()
  const summary = {
    sessionId: wanted,
    count: 0,
    success: 0,
    failed: 0,
    durationMs: 0,
    averageMs: 0,
    lastAt: null,
    servers: [],
  }

  if (wanted !== null) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || entry.kind !== 'exec' || entry.sessionId !== wanted) continue
      summary.count += 1
      if (entry.outcome === 'success') summary.success += 1
      else summary.failed += 1
      summary.durationMs += numericDuration(entry)
      if (typeof entry.at === 'string' && (summary.lastAt === null || entry.at > summary.lastAt)) summary.lastAt = entry.at
      const name = typeof entry.server === 'string' && entry.server.length > 0 ? entry.server : null
      if (name === null) continue
      if (!byServer.has(name)) byServer.set(name, emptyBucket(name))
      addToBucket(byServer.get(name), entry)
    }
  }

  summary.averageMs = summary.count > 0 ? Math.round(summary.durationMs / summary.count) : 0

  // Keep the mentioned resources in mention order, then append any target that
  // ran from an explicit remote_exec task without being a session candidate.
  const names = []
  for (const name of Array.isArray(candidates) ? candidates : []) {
    const value = String(name)
    if (value && !names.includes(value)) names.push(value)
  }
  for (const name of [...byServer.keys()].sort()) {
    if (!names.includes(name)) names.push(name)
  }
  summary.servers = names.map((name) => {
    const bucket = byServer.get(name) ?? emptyBucket(name)
    return { ...bucket, averageMs: bucket.count > 0 ? Math.round(bucket.durationMs / bucket.count) : 0 }
  })
  return summary
}
