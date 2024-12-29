import { Wallet } from '@project-serum/anchor'
import {
  Connection,
  Keypair,
  type RpcResponseAndContext,
  type SignatureResult,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'
import fetch from 'cross-fetch'

/** The first array element (index 0) has breedingCount & activeCount. */
interface ApiResultOne {
  result: {
    data: {
      json: {
        breedingCount: number
        activeCount: number
      }
    }
  }
}

/** An Agent’s structure as returned by the second array element (index 1). */
interface Agent {
  id: number
  appId: string
  slug: string
  name: string
  walletAddress: string
  tokenAddress: string
  tokenImage: string
  twitterUsername: string | null
  redditUsername: string | null
  parentId: number | null
  teeVerifiedLink: string | null
  proposalDuration: number
  generation: number
  createdAt: string
  status: string
  breedStatus: string
  marketCap: string
  balance: string
  capabilities: string[]
}

/** The second array element has an array of agents plus meta information. */
interface AgentsResult {
  result: {
    data: {
      json: Agent[]
      meta: {
        values: Record<string, string[]>
      }
    }
  }
}

type SporeApiResponse = [ApiResultOne, AgentsResult]

/**
 * Configuration constants
 */
const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const SPORE_API_URL = 'https://www.spore.fun/api/trpc/status,listAgent?batch=1'

// Polling interval in milliseconds.
const POLL_INTERVAL_MS = 100

// Which agents we care about
const AGENT_ABEL_ID = 6
const AGENT_TRINITY_ID = 7

//
// 1) SETUP SOLANA + WALLET
//
const connection = new Connection(RPC_URL)

/** Recover keypair from PRIVATE_KEY (base58) */
const privateKeyBase58 = process.env.PRIVATE_KEY ?? ''
if (!privateKeyBase58) {
  console.error('Error: PRIVATE_KEY environment variable is not set.')
  process.exit(1)
}
const keypair = Keypair.fromSecretKey(bs58.decode(privateKeyBase58))
const wallet = new Wallet(keypair)

async function buyTokenWithJupiter(mint?: string): Promise<void> {
  if (!mint || !mint.trim()) {
    console.error('buyTokenWithJupiter called with invalid outputMint:', mint)
    return
  }

  try {
    console.log(`\nAttempting to buy token: ${mint}`)

    // 1) Get a quote from Jupiter (SOL -> outputMint).
    const amountLamports = 1_000_000_000 // 1 SOL
    const slippageBps = 5000 // 50%

    // Construct the quote URL
    const quoteUrl = new URL('https://quote-api.jup.ag/v6/quote')
    quoteUrl.searchParams.set('inputMint', 'So11111111111111111111111111111111111111112')
    quoteUrl.searchParams.set('outputMint', mint)
    quoteUrl.searchParams.set('amount', amountLamports.toString())
    quoteUrl.searchParams.set('slippageBps', slippageBps.toString())

    // Request the quote
    const quoteResponse = await fetch(quoteUrl).then((res) => res.json())
    if (!quoteResponse || quoteResponse.error) {
      throw new Error(`Quote API returned an error: ${quoteResponse?.error}`)
    }

    // 2) Request the swap transaction from Jupiter
    const swapUrl = 'https://quote-api.jup.ag/v6/swap'
    const swapBody = JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    })

    const swapResponse = await fetch(swapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: swapBody,
    }).then((res) => res.json())

    if (!swapResponse || swapResponse.error) {
      throw new Error(`Swap API returned an error: ${swapResponse?.error ?? 'Unknown error'}`)
    }

    const { swapTransaction } = swapResponse
    if (!swapTransaction) {
      throw new Error('No swapTransaction found in response.')
    }

    // 3) Deserialize & sign the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64')
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf)
    transaction.sign([wallet.payer])

    // 4) Send & confirm the transaction
    const rawTransaction = transaction.serialize()
    const txid = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
    })

    const latestBlockHash = await connection.getLatestBlockhash()
    const confirmation = await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txid,
    })

    handleTxConfirmation(txid, confirmation)
  } catch (error) {
    console.error('Jupiter swap failed:', error)
  }
}

/** Logs the transaction confirmation results */
function handleTxConfirmation(
  txid: string,
  confirmation: RpcResponseAndContext<SignatureResult>,
): void {
  if (confirmation.value.err == null) {
    console.log('Swap successful!')
    console.log(`View on Solscan: https://solscan.io/tx/${txid}`)
  } else {
    console.error('Transaction error:', confirmation.value.err)
  }
}

let done = false

async function pollSporeApi(): Promise<void> {
  // If we've already done the buys, no need to continue
  if (done) return

  try {
    const resp = await fetch(SPORE_API_URL)
    const data = (await resp.json()) as SporeApiResponse

    const agents = data[1].result.data.json
    const abel = agents.find((agent) => agent.id === AGENT_ABEL_ID)
    const trinity = agents.find((agent) => agent.id === AGENT_TRINITY_ID)

    const abelToken = abel?.tokenAddress?.trim() ?? ''
    const trinityToken = trinity?.tokenAddress?.trim() ?? ''

    // If either has a non-empty token address, do the buys
    if (abelToken.length > 0 || trinityToken.length > 0) {
      done = true

      console.log(`\n=== Detected reveal ===\nAbel tokenAddress: ${abelToken}\nTrinity tokenAddress: ${trinityToken}\nInitiating Jupiter swaps...`)

      await Promise.all([buyTokenWithJupiter(abelToken), buyTokenWithJupiter(trinityToken)])
      return
    }
  } catch (error) {
    console.error('Error polling Spore API:', error)
  }

  // Use setTimeout to ensure only one request at a time.
  setTimeout(pollSporeApi, POLL_INTERVAL_MS)
}

// Start polling
pollSporeApi()
