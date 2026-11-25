import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Outbound POST for webhooks with an address check that cannot be bypassed by DNS rebinding:
 * the address is validated inside the socket's own lookup, so the connection goes to exactly the
 * address that was checked. Redirects are not followed.
 */

export class BlockedAddressError extends Error {}

export function isPublicAddress(address: string): boolean {
  let a: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    a = ipaddr.parse(address);
  } catch {
    return false;
  }
  if (a.kind() === 'ipv6' && (a as ipaddr.IPv6).isIPv4MappedAddress()) a = (a as ipaddr.IPv6).toIPv4Address();
  return a.range() === 'unicast';
}

function safeLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = (addresses as unknown as dns.LookupAddress[]).filter((x) => allowPrivate || isPublicAddress(x.address));
      if (!list.length) return callback(new BlockedAddressError(`${hostname} resolves only to internal or private addresses`), '', 0);
      if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface PostResult {
  status: number;
  /** First bytes of the response body, for the delivery log. */
  snippet: string;
}

export function validateWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new Error('Webhook URLs must use https');
  if (u.username || u.password) throw new Error('Put credentials in the Authorization header field, not in the URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowPrivate && !isPublicAddress(host)) throw new Error('Internal and private addresses are blocked');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) {
    throw new Error('Internal and private addresses are blocked');
  }
  return u;
}

export async function postJson(url: string, headers: Record<string, string>, body: string, opts: { timeoutMs: number; allowPrivate: boolean }): Promise<PostResult> {
  const u = validateWebhookUrl(url, opts.allowPrivate);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString(), 'user-agent': 'workspace-mcp-webhook', ...headers },
        lookup: safeLookup(opts.allowPrivate),
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < 512) chunks.push(c);
          size += c.length;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, snippet: Buffer.concat(chunks).toString('utf8').slice(0, 200) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timed out after ${opts.timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}
