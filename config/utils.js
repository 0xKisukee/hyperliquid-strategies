const { Hyperliquid } = require('hyperliquid');

// Initialize SDK with environment variables
function initializeSDK() {
    return new Hyperliquid({
        privateKey: process.env.MAIN_PRIVATE_KEY,
        walletAddress: process.env.MAIN_API_ADDRESS,
        enableWs: true
    });
}

// Fetch candle data using WebSocket
async function fetchCandleData(sdk, coin, interval, count) {
    const endTime = Date.now();
    const startTime = endTime - (count * 60 * 1000);

    const response = await sdk.subscriptions.postRequest('info', {
        type: 'candleSnapshot',
        req: {
            coin: coin,
            interval: interval,
            startTime: startTime,
            endTime: endTime
        }
    });

    return response.data;
}

// Get decimal precision for a pair
async function getDecimalPrecision(sdk, pair) {
    const meta = await sdk.info.perpetuals.getMeta();
    const asset = meta.universe.find(asset => asset.name === pair);
    
    if (!asset) {
        return {
            sizeDecimals: 4,
            maxPriceDecimals: 6
        };
    }

    const MAX_DECIMALS = 6;
    const maxPriceDecimals = Math.min(5, MAX_DECIMALS - asset.szDecimals);
    
    return {
        sizeDecimals: asset.szDecimals,
        maxPriceDecimals: maxPriceDecimals
    };
}

// Format price according to precision rules
function formatPrice(price) {
    if (Number.isInteger(price)) {
        return price.toString();
    }

    const significantFigures = price.toString().replace(/^0+\.?|\./g, '').length;
    
    if (significantFigures > 5) {
        return price.toPrecision(5);
    }

    return price.toString();
}

// Unified order placement function that handles both order placement and risk management
async function placeOrder(sdk, config, pair, isBuy, currentPrice) {
    // Get L2 book for price information
    const l2Book = await sdk.info.getL2Book(pair);
    const entryPrice = isBuy ? 
        parseFloat(l2Book.levels[1][2].px) : 
        parseFloat(l2Book.levels[0][2].px);
    
    // Get decimal precision for the pair
    const { sizeDecimals, maxPriceDecimals } = await getDecimalPrecision(sdk, pair);
    const pairConfig = config.trading.pairs.find(p => p.pair === pair);
    const currencySize = Number((pairConfig.positionSize / entryPrice).toFixed(sizeDecimals));
    
    // Calculate take profit and stop loss levels
    const takeProfitDistance = entryPrice * pairConfig.takeProfitPercentage;
    const stopLossDistance = takeProfitDistance / pairConfig.riskRewardRatio;

    const stopLossPrice = isBuy ?
        Number((entryPrice - stopLossDistance).toFixed(maxPriceDecimals)) :
        Number((entryPrice + stopLossDistance).toFixed(maxPriceDecimals));

    const takeProfitPrice = isBuy ?
        Number((entryPrice + takeProfitDistance).toFixed(maxPriceDecimals)) :
        Number((entryPrice - takeProfitDistance).toFixed(maxPriceDecimals));

    // Set position flag
    config.position[pair].isInPosition = true;

    // Place all orders (main order, stop loss, and take profit)
    const result = await sdk.exchange.placeOrder({
        orders: [{
            coin: pair,
            is_buy: isBuy,
            sz: currencySize.toString(),
            limit_px: formatPrice(entryPrice),
            order_type: { limit: { tif: 'Gtc' } },
            reduce_only: false
        },
        {
            coin: pair,
            is_buy: !isBuy,
            sz: currencySize.toString(),
            limit_px: formatPrice(stopLossPrice),
            order_type: {
                trigger: {
                    isMarket: true,
                    triggerPx: formatPrice(stopLossPrice),
                    tpsl: "sl"
                }
            },
            reduce_only: true
        },
        {
            coin: pair,
            is_buy: !isBuy,
            sz: currencySize.toString(),
            limit_px: formatPrice(takeProfitPrice),
            order_type: {
                trigger: {
                    isMarket: true,
                    triggerPx: formatPrice(takeProfitPrice),
                    tpsl: "tp"
                }
            },
            reduce_only: true
        }],
        grouping: 'normalTpsl',
    });
    
    // Handle both resting and filled order statuses
    const mainOrderStatus = result.response.data.statuses[0];
    if (mainOrderStatus.filled) {
        config.position[pair].mainOrderId = mainOrderStatus.filled.oid;
    } else if (mainOrderStatus.resting) {
        config.position[pair].mainOrderId = mainOrderStatus.resting.oid;
    }

    return result;
}

// Update performance metrics
function updatePerformanceMetrics(config, pair, fill) {
    const pairTracking = config.tracking[pair];
    pairTracking.totalTrades++;
    
    if (fill.closedPnl > 0) {
        pairTracking.totalWins++;
    } else if (fill.closedPnl < 0) {
        pairTracking.totalLosses++;
    }

    pairTracking.totalPnl += fill.closedPnl - fill.fee;
    
    console.log(`[${pair}] Performance:`, {
        accruedPnl: pairTracking.totalPnl,
        totalTrades: pairTracking.totalTrades,
        totalWins: pairTracking.totalWins,
        totalLosses: pairTracking.totalLosses
    });
}

// Initialize subscriptions for all pairs
async function initializeSubscriptions(sdk, config, onCandle, onFill) {
    // Subscribe to candles for all pairs
    for (const pair of config.trading.pairs) {
        sdk.subscriptions.subscribeToCandle(pair.pair, config.candles.interval, async (data) => {
            await onCandle(pair, data);
        });
    }

    // Subscribe to fills
    sdk.subscriptions.subscribeToUserFills(process.env.MAIN_WALLET_ADDRESS, async (data) => {
        if (!data.isSnapshot && data.fills.length > 0) {
            const fill = data.fills[0];
            const pair = config.trading.pairs.find(p => p.pair === fill.coin);
            if (pair) {
                await onFill(fill.coin, fill);
            }
        }
    });
}

module.exports = {
    initializeSDK,
    fetchCandleData,
    getDecimalPrecision,
    formatPrice,
    placeOrder,
    updatePerformanceMetrics,
    initializeSubscriptions
}; 