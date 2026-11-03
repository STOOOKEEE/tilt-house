import { Account, PublicKey, Signer } from 'near-api-js'
import type { JsonRpcProvider } from 'near-api-js'
import type { useSignRawHash } from '@privy-io/react-auth/extended-chains'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

// From near-examples/hello-privy (src/context/signer.ts): Privy's embedded wallet signs the hash
// that near-api-js computes for transactions, delegate actions and NEP-413 messages.
type SignRawHash = ReturnType<typeof useSignRawHash>['signRawHash']

const IMPLICIT_ACCOUNT = /^[a-f0-9]{64}$/i

export class PrivySigner extends Signer {
  private readonly signRawHash: SignRawHash
  private readonly accountId: string
  private readonly provider: JsonRpcProvider

  constructor(signRawHash: SignRawHash, accountId: string, provider: JsonRpcProvider) {
    super()
    this.signRawHash = signRawHash
    this.accountId = accountId
    this.provider = provider
  }

  async getPublicKey(): Promise<PublicKey> {
    // An implicit account id is the hex of its ed25519 public key.
    if (IMPLICIT_ACCOUNT.test(this.accountId)) {
      return new PublicKey({ keyType: 0, data: hexToBytes(this.accountId) })
    }
    const account = new Account(this.accountId, this.provider)
    const { keys } = await account.getAccessKeyList()
    if (!keys.length) throw new Error('The account has no registered access key')
    return PublicKey.fromString(keys[0].public_key)
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.signRawHash({
      address: this.accountId,
      chainType: 'near',
      hash: `0x${bytesToHex(bytes)}`,
    })
    return hexToBytes(signature.replace(/^0x/, ''))
  }
}
