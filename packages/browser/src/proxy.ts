import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect as netConnect } from 'node:net'
import { type DnsLookup, type RangeOptions, resolveAndPin } from '@strummer/safety'

export interface SsrfProxyOptions extends RangeOptions {
  /** DNS resolver (injectable in tests). Defaults to the system resolver. */
  lookup?: DnsLookup
}

export interface SsrfProxy {
  /** `http://127.0.0.1:<port>` — pass as Chromium's `proxy.server`. */
  url: string
  port: number
  close(): Promise<void>
}

/**
 * Tier-2 SSRF defense: a loopback forward proxy that resolves every target host
 * **once**, refuses it if the resolved IP is in a blocked range, and connects to
 * exactly that **pinned** IP — so an allowlisted hostname that DNS-rebinds to a
 * private/metadata address (the gap Tier-1's route layer can't see) is closed.
 * Re-resolution on redirects goes through the same check, because every hop is a
 * fresh request/CONNECT to the proxy.
 *
 * Handles plain HTTP (absolute-form requests) and HTTPS (`CONNECT` tunnels). For
 * HTTPS the host:port from the CONNECT line is pinned before the blind tunnel
 * opens — the encrypted bytes are never inspected.
 */
export async function createSsrfProxy(options: SsrfProxyOptions = {}): Promise<SsrfProxy> {
  const { lookup, allowPrivate } = options
  const range: RangeOptions = allowPrivate === undefined ? {} : { allowPrivate }

  const server: Server = createServer((clientReq, clientRes) => {
    let target: URL
    try {
      target = new URL(clientReq.url ?? '')
    } catch {
      clientRes.writeHead(400)
      clientRes.end('bad request target')
      return
    }
    void resolveAndPin(target.hostname, lookup, range).then(
      (ip) => {
        const upstream = httpRequest(
          {
            host: ip,
            port: target.port ? Number(target.port) : 80,
            path: `${target.pathname}${target.search}`,
            method: clientReq.method,
            headers: { ...clientReq.headers, host: target.host },
          },
          (upRes) => {
            clientRes.writeHead(upRes.statusCode ?? 502, upRes.headers)
            upRes.pipe(clientRes)
          },
        )
        upstream.on('error', () => {
          if (!clientRes.headersSent) clientRes.writeHead(502)
          clientRes.end('upstream error')
        })
        clientReq.pipe(upstream)
      },
      (err: Error) => {
        clientRes.writeHead(502)
        clientRes.end(`blocked: ${err.message}`)
      },
    )
  })

  // HTTPS: pin the CONNECT target, then blind-tunnel.
  server.on('connect', (req, clientSocket, head) => {
    const [host = '', portStr] = (req.url ?? '').split(':')
    void resolveAndPin(host, lookup, range).then(
      (ip) => {
        const upstream = netConnect(Number(portStr) || 443, ip, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.write(head)
          upstream.pipe(clientSocket)
          clientSocket.pipe(upstream)
        })
        upstream.on('error', () => clientSocket.destroy())
      },
      () => {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        clientSocket.destroy()
      },
    )
    clientSocket.on('error', () => {})
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
