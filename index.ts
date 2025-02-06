import {
    getEMA,
    getBB,
    getRSI
} from './indicators'
import {
    CRYPTO_COMPARE_API_KEY,
    LOG_LEVEL,
    CANDLE_AGGREGATE_MINUTES,
    GET_MARKET_DATA_INTERVAL_SECONDS,
    STOP_LOSS,
    TAKE_PROFIT,
    BUY_TOKEN_ADDRESSES,
    QUOTE_SYMBOL,
    SLIPPAGE_PERCENT,
    TRANSACTION_PRIORITY_FEE,
    RSI_TO_BUY,
    RSI_TO_SELL,
} from './constants'

import {
    logger,
    request,
    sleep,
} from "./utils"

import {version} from './package.json'
import * as fs from "fs"
import {
    getSolBalance,
    getTokenAmountByAddress,
} from "./wallet";
import {buyToken} from "./trade";

interface Position {
    buyPrice: number;
    amount: number;
    buySymbol: string;
    quoteSymbol: string;
}

interface TokenState {
    buySymbol: string;
    buyTokenBalance: number;
    buyTokenDecimals: number;
    activePosition: Position | null;
}

let quoteAddress: string
let quoteTokenBalance: number
let quoteTokenDecimals: number
let solBalance: number

// Map to store state for each token
const tokenStates: Map<string, TokenState> = new Map()

const positionsDir = './positions'
if (!fs.existsSync(positionsDir)) {
    fs.mkdirSync(positionsDir)
}

const main = async () => {
    await init()

    try {
        await analyzeMarket()
        setTimeout(runAnalyzeMarket, GET_MARKET_DATA_INTERVAL_SECONDS * 1000)
    } catch (error) {
        logger.error(error, 'Error occurred while analyzing market:')
    }
}

const runAnalyzeMarket = async () => {
    try {
        await analyzeMarket()
    } catch (error) {
        logger.error(error, 'Error occurred while analyzing market:')
    } finally {
        setTimeout(runAnalyzeMarket, GET_MARKET_DATA_INTERVAL_SECONDS * 1000)
    }
}

async function init() {
    logger.level = LOG_LEVEL
    logger.info(`
88888888888 8888888b.         d8888 8888888b.  8888888 8888888888 
    888     888   Y88b       d88888 888   Y88b   888   888        
    888     888    888      d88P888 888    888   888   888        
    888     888   d88P     d88P 888 888    888   888   8888888    
    888     8888888P"     d88P  888 888    888   888   888        
    888     888 T88b     d88P   888 888    888   888   888        
    888     888  T88b   d8888888888 888  .d88P   888   888        
    888     888   T88b d88P     888 8888888P"  8888888 8888888888
      
            Solana ultimate trading bot. version: ${version}
`)

    logger.info(`Stop Loss is ${STOP_LOSS}%.`)
    logger.info(`Take Profit is ${TAKE_PROFIT}%.`)
    logger.info(`Analyzing market price every ${GET_MARKET_DATA_INTERVAL_SECONDS} seconds.`)
    logger.info(`Candle aggregate for ${CANDLE_AGGREGATE_MINUTES} min.`)
    logger.info(`Slippage is ${SLIPPAGE_PERCENT}%.`)
    logger.info(`Transaction priority fee is ${TRANSACTION_PRIORITY_FEE}.`)

    try {
        // Initialize quote token
        const quoteAssetData = await getAssetDataByToken(QUOTE_SYMBOL)
        if (!quoteAssetData?.data) {
            throw new Error(`Token ${QUOTE_SYMBOL} is not found.`)
        }
        quoteAddress = tokenMintMap[QUOTE_SYMBOL]

        // Initialize each buy token
        for (const address of BUY_TOKEN_ADDRESSES) {
            const buyAssetData = await getAssetDataByAddress(address)
            if (buyAssetData?.Err?.message) {
                logger.error(`Error initializing token at address ${address}: ${buyAssetData.Err.message}`)
                continue
            }

            const buySymbol: string = buyAssetData?.Data?.SYMBOL
            tokenStates.set(address, {
                buySymbol,
                buyTokenBalance: 0,
                buyTokenDecimals: 0,
                activePosition: null
            })

            logger.debug(`Initialized token ${buySymbol} at address ${address}`)
        }
    } catch (error) {
        logger.error(error, 'Error occurred while getting assets data')
        process.exit(1)
    }

    await getBalances()

    for (const [address, state] of tokenStates) {
        logger.info(`Start trading ${state.buySymbol}-${QUOTE_SYMBOL}.`)
        try {
            await loadSavedPosition(address)
            if (state.activePosition) {
                logger.info(`Saved position found for ${state.buySymbol}. Balance: ${state.activePosition.amount} ${state.activePosition.buySymbol}. BuyPrice is ${state.activePosition.buyPrice} ${state.activePosition.quoteSymbol}.`)
            }
        } catch (error) {
            logger.error(error, `Error occurred while loading the saved position for ${state.buySymbol}`)
        }
    }

    logger.info('———————————————————————')
}

async function analyzeMarket() {
    for (const [address, state] of tokenStates) {
        try {
            await analyzeTokenMarket(address, state)
        } catch (error) {
            logger.error(error, `Error analyzing market for ${state.buySymbol}`)
        }
    }
    logger.info('———————————————————————')
}

async function analyzeTokenMarket(address: string, state: TokenState) {
    const candleData = await getCandleData(state.buySymbol)
    if (!candleData || !candleData.Data || !candleData.Data.Data || !candleData.Data.Data.length) {
        if (candleData.Response === 'Error') {
            throw new Error(`Failed to fetch candle data: ${candleData.Message}`)
        } else {
            throw new Error('Failed to fetch candle data or data is empty')
        }
    }

    const data = candleData.Data.Data
    const closePrice = data[data.length - 1].close
    const emaShort = getEMA(data, 5)
    const emaMedium = getEMA(data, 20)
    const bb = getBB(data)
    const rsi = getRSI(data)

    logger.info(`${state.buySymbol} Price: ${closePrice} ${QUOTE_SYMBOL}`)
    logger.info(`${state.buySymbol} EMA short: ${emaShort}`)
    logger.info(`${state.buySymbol} EMA medium: ${emaMedium}`)
    logger.info(`${state.buySymbol} BB lower: ${bb.lower}`)
    logger.info(`${state.buySymbol} BB upper: ${bb.upper}`)
    logger.info(`${state.buySymbol} RSI: ${rsi}`)

    if (state.buyTokenBalance > 0) {
        logger.debug(`${state.buySymbol} balance is ${state.buyTokenBalance}. Looking for sell signal...`)

        if (state.activePosition) {
            if (closePrice <= state.activePosition.buyPrice * (100 - STOP_LOSS) / 100) {
                logger.warn(`${state.buySymbol} Stop Loss is reached. Start selling...`)
                await sell(address, closePrice)
            }

            if (closePrice >= state.activePosition.buyPrice * (100 + TAKE_PROFIT) / 100) {
                logger.warn(`${state.buySymbol} Take Profit is reached. Start selling...`)
                await sell(address, closePrice)
            }
        }

        if (((emaShort < emaMedium) || (closePrice > bb.upper)) && rsi >= RSI_TO_SELL) {
            logger.warn(`${state.buySymbol} SELL signal is detected. Start selling...`)
            await sell(address, closePrice)
        }
    }

    if (quoteTokenBalance > 0) {
        logger.debug(`Quote Token balance is ${quoteTokenBalance} ${QUOTE_SYMBOL}. Looking for buy signal for ${state.buySymbol}...`)

        if (((emaShort > emaMedium) || (closePrice < bb.lower)) && rsi <= RSI_TO_BUY) {
            logger.warn(`${state.buySymbol} BUY signal is detected. Buying...`)
            await buy(address, closePrice)
        }
    }
}

async function sell(address: string, price: number) {
    const state = tokenStates.get(address)
    if (!state) return

    if (state.activePosition) {
        logger.warn(`${state.buySymbol} Price difference is ${price - state.activePosition.buyPrice} (${Math.sign(price - state.activePosition.buyPrice) * Math.round((state.activePosition.buyPrice / price) * 100 - 100) / 100}%)`)
    }
    await getBalances()

    const amountWithDecimals = state.buyTokenBalance * (10 ** state.buyTokenDecimals)

    try {
        await buyToken(address, quoteAddress, amountWithDecimals.toString(), logger)
    } catch (error: any) {
        if (error.err) {
            logger.error(`Got error on sell transaction for ${state.buySymbol}: ${error.err.message}`)
        }

        logger.error(error, `Got some error on sell transaction for ${state.buySymbol}`)
        return
    }

    logger.warn(`Sold ${state.buyTokenBalance} ${state.buySymbol}.`)

    logger.info(`sleeping for 30s`)
    await sleep(30000)
    await getBalances()
    logger.warn(`Bought ${quoteTokenBalance} ${QUOTE_SYMBOL}. 1 ${state.buySymbol} = ${price} ${QUOTE_SYMBOL}`)
    await clearSavedPosition(address)
}

async function buy(address: string, price: number) {
    const state = tokenStates.get(address)
    if (!state) return

    await getBalances()

    const amountWithDecimals = quoteTokenBalance * (10 ** quoteTokenDecimals)

    try {
        await buyToken(quoteAddress, address, amountWithDecimals.toString(), logger)
    } catch (error: any) {
        if (error.err) {
            logger.error(`Got error on buy transaction for ${state.buySymbol}: ${error.err.message}`)
        }

        logger.error(error, `Got some error on buy transaction for ${state.buySymbol}`)
        return
    }

    if (state.activePosition) {
        logger.info(`Previous active position found for ${state.buySymbol}. Updating...`)
    }

    logger.warn(`Sold ${quoteTokenBalance} ${QUOTE_SYMBOL}. For ${price} ${QUOTE_SYMBOL} per ${state.buySymbol}`)

    logger.info(`sleeping for 30s`)
    await sleep(30000)
    await getBalances()

    logger.warn(`Bought ${state.buyTokenBalance} ${state.buySymbol}.`)

    state.activePosition = {
        buyPrice: state.activePosition ? (state.activePosition.buyPrice + price) / 2 : price,
        amount: state.buyTokenBalance,
        buySymbol: state.buySymbol,
        quoteSymbol: QUOTE_SYMBOL
    }
    await savePosition(address)
}

async function getAssetDataByAddress(address: string): Promise<any> {
    return await request(
        'https://data-api.cryptocompare.com/onchain/v1/data/by/address?chain_symbol=SOL' +
        '&address=' + address +
        '&api_key=' + CRYPTO_COMPARE_API_KEY,
        {})
}

// Token mint addresses on Solana mainnet
const tokenMintMap: { [key: string]: string } = {
    'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
};

async function getAssetDataByToken(token: string): Promise<any> {
    const mintAddress = tokenMintMap[token] || token;
    return await request(
        `https://api.jup.ag/price/v2?ids=${mintAddress}`,
        {})
}

async function getCandleData(buySymbol: string): Promise<any> {
    return await request(
        'https://min-api.cryptocompare.com/data/v2/histominute?limit=50' +
        '&fsym=' + buySymbol +
        '&tsym=' + QUOTE_SYMBOL +
        '&aggregate=' + CANDLE_AGGREGATE_MINUTES,
        {
            method: 'GET',
            headers: {'authorization': CRYPTO_COMPARE_API_KEY},
        })
}

async function loadSavedPosition(address: string) {
    const state = tokenStates.get(address)
    if (!state) return

    const positionFilePath = `${positionsDir}/${address}.json`
    if (fs.existsSync(positionFilePath)) {
        const data = fs.readFileSync(positionFilePath, 'utf8')
        const position = JSON.parse(data)
        if (position.buySymbol !== state.buySymbol || position.quoteSymbol !== QUOTE_SYMBOL) {
            logger.warn(`Previously saved pair is ${position.buySymbol}-${position.quoteSymbol}. But now trading ${state.buySymbol}-${QUOTE_SYMBOL}. Clearing saved position...`)
            await clearSavedPosition(address)
        } else {
            state.activePosition = position
            logger.debug(`Position loaded from file for ${state.buySymbol}.`)
        }
    } else {
        logger.info(`No previous position found for ${state.buySymbol}. Starting fresh.`)
    }
}

async function savePosition(address: string) {
    const state = tokenStates.get(address)
    if (!state || !state.activePosition) return

    const positionFilePath = `${positionsDir}/${address}.json`
    const data = JSON.stringify(state.activePosition)
    fs.writeFileSync(positionFilePath, data, 'utf8')
    logger.debug(state.activePosition, `Position file saved for ${state.buySymbol}`)
}

async function clearSavedPosition(address: string) {
    const state = tokenStates.get(address)
    if (!state) return

    state.activePosition = null
    const positionFilePath = `${positionsDir}/${address}.json`
    if (fs.existsSync(positionFilePath)) {
        fs.unlinkSync(positionFilePath)
        logger.debug(`Position file was cleared for ${state.buySymbol}.`)
    }
}

async function getBalances() {
    try {
        logger.debug(`Getting balance amounts.`)
        solBalance = await getSolBalance()

        // Get quote token balance
        const quoteTokenAmount = await getTokenAmountByAddress(quoteAddress, logger)
        quoteTokenBalance = quoteTokenAmount.amount / (10 ** quoteTokenAmount.decimals)
        quoteTokenDecimals = quoteTokenAmount.decimals

        // Get balance for each buy token
        for (const [address, state] of tokenStates) {
            const buyTokenAmount = await getTokenAmountByAddress(address, logger)
            state.buyTokenBalance = buyTokenAmount.amount / (10 ** buyTokenAmount.decimals)
            state.buyTokenDecimals = buyTokenAmount.decimals
        }

        if (solBalance < 0.001) {
            logger.error('Insufficient SOL balance. 0.001 SOL required to work properly.')
            process.exit(1)
        }

        logger.info(`SOL Balance: ${solBalance} SOL`)
        logger.info(`Quote Token balance: ${quoteTokenBalance} ${QUOTE_SYMBOL}`)
        for (const [_, state] of tokenStates) {
            logger.info(`${state.buySymbol} balance: ${state.buyTokenBalance}`)
        }
    } catch (error) {
        logger.error(error, 'Error occurred while getting wallet balances')
        process.exit(1)
    }
}

main();
