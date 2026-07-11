import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { serveStatic } from '../server.js'

class FakeResponse extends Writable {
  statusCode = 200
  headers: Record<string, string> = {}
  chunks: Buffer[] = []

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    callback()
  }

  writeHead(statusCode: number, headers?: Record<string, string>) {
    this.statusCode = statusCode
    this.headers = headers ?? {}
    return this
  }

  body() {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

function callServeStatic(url: string, webDir: string) {
  const res = new FakeResponse()
  const handled = serveStatic({ url, headers: {} } as any, res as any, webDir)
  return new Promise<{ handled: boolean; res: FakeResponse }>((resolve) => {
    res.on('finish', () => resolve({ handled, res }))
  })
}

describe('web static asset fallback', () => {
  it('does not serve index.html for missing hashed assets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cuttlefish-web-'))
    try {
      mkdirSync(join(dir, 'assets'))
      writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')

      const { handled, res } = await callServeStatic('/assets/page-missing.js', dir)

      expect(handled).toBe(true)
      expect(res.statusCode).toBe(404)
      expect(res.headers['Content-Type']).toBe('text/plain')
      expect(res.body()).toContain('Not found')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps SPA fallback for client-side routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cuttlefish-web-'))
    try {
      writeFileSync(join(dir, 'index.html'), '<div id="root"></div>')

      const { handled, res } = await callServeStatic('/limits', dir)

      expect(handled).toBe(true)
      expect(res.statusCode).toBe(200)
      expect(res.headers['Content-Type']).toBe('text/html')
      expect(res.body()).toContain('root')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects sibling-prefix traversal outside the web root (AR-05)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cuttlefish-web-parent-'))
    try {
      const webDir = join(parent, 'web')
      mkdirSync(webDir)
      writeFileSync(join(webDir, 'index.html'), '<div id="root"></div>')
      // A sibling directory that shares the `web` prefix holds a secret.
      const evilDir = join(parent, 'web_evil')
      mkdirSync(evilDir)
      writeFileSync(join(evilDir, 'secret'), 'TOP SECRET')

      const { handled, res } = await callServeStatic('/../web_evil/secret', webDir)

      expect(handled).toBe(true)
      expect(res.statusCode).toBe(403)
      expect(res.body()).not.toContain('TOP SECRET')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
