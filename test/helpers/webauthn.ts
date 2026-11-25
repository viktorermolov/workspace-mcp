import { createHash, createPrivateKey, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';

/**
 * A minimal software WebAuthn authenticator (ES256, attestation "none") for tests.
 * It produces the same JSON that @simplewebauthn/browser sends, so the server code path is the real one.
 */

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

type Cbor = number | string | Buffer | CborMap | { [k: string]: Cbor };
interface CborMap extends Map<Cbor, Cbor> {}

function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([cborHead(3, b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k as Cbor), cbor(val as Cbor)])]);
}

const b64u = (b: Buffer) => b.toString('base64url');

export interface Credential {
  id: Buffer;
  privateKey: KeyObject;
  publicJwk: { x: string; y: string };
  userHandle: string;
  counter: number;
}

export class SoftAuthenticator {
  credentials: Credential[] = [];
  private rpId: string;
  private origin: string;
  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
  }

  /** Serialises the credentials (test keys only) so a later process can sign in with them. */
  export(): unknown {
    return this.credentials.map((c) => ({ id: b64u(c.id), privateKey: c.privateKey.export({ format: 'jwk' }), publicJwk: c.publicJwk, userHandle: c.userHandle, counter: c.counter }));
  }

  static import(rpId: string, origin: string, data: unknown): SoftAuthenticator {
    const a = new SoftAuthenticator(rpId, origin);
    for (const c of data as { id: string; privateKey: JsonWebKey; publicJwk: { x: string; y: string }; userHandle: string; counter: number }[]) {
      a.credentials.push({ id: Buffer.from(c.id, 'base64url'), privateKey: createPrivateKey({ key: c.privateKey, format: 'jwk' } as Parameters<typeof createPrivateKey>[0]), publicJwk: c.publicJwk, userHandle: c.userHandle, counter: c.counter });
    }
    return a;
  }

  private rpIdHash() {
    return createHash('sha256').update(this.rpId).digest();
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** Answers PublicKeyCredentialCreationOptionsJSON. */
  register(options: { challenge: string; user: { id: string } }) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const id = randomBytes(16);
    const cose = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]);
    const counter = Buffer.alloc(4);
    const credLen = Buffer.alloc(2);
    credLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([this.rpIdHash(), Buffer.from([0x45]), counter, Buffer.alloc(16), credLen, id, cbor(cose)]);
    const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
    this.credentials.push({ id, privateKey, publicJwk: jwk, userHandle: options.user.id, counter: 0 });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ['internal'],
        publicKeyAlgorithm: -7,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Answers PublicKeyCredentialRequestOptionsJSON (discoverable credential). */
  authenticate(options: { challenge: string }, credential = this.credentials[this.credentials.length - 1]) {
    if (!credential) throw new Error('no credential');
    credential.counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.counter);
    const authenticatorData = Buffer.concat([this.rpIdHash(), Buffer.from([0x05]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', options.challenge);
    const signer = createSign('SHA256');
    signer.update(Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]));
    const signature = signer.sign(credential.privateKey);
    return {
      id: b64u(credential.id),
      rawId: b64u(credential.id),
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(signature),
        userHandle: credential.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
