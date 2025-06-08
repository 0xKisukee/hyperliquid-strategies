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
    const secondsInInterval = {
        '1m': 60,
        '5m': 300,
        '15m': 900,
        '30m': 1800,
        '1h': 3600,
    }

    const endTime = Date.now();
    const startTime = endTime - (count * secondsInInterval[interval] * 1000);

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

// Unified order placement function that handles both order placement and risk management
async function placeOrder(sdk, config, pair, isBuy) {
    console.log('Placing ' + (isBuy ? 'buy' : 'sell') + ' order on ' + pair);

    // Get L2 book for price information
    const l2Book = await sdk.info.getL2Book(pair);

    // Get the 3rd level price to pass as a market order
    const orderPrice = isBuy ?
        parseFloat(l2Book.levels[1][0].px) :
        parseFloat(l2Book.levels[0][0].px);

    const pairConfig = config.trading.pairs.find(p => p.pair === pair);
    const currencySize = Number((pairConfig.positionSize / orderPrice).toFixed(pairConfig.sizeDecimals));

    const mainOrderResult = await sdk.exchange.placeOrder({
        orders: [{
            coin: pair,
            is_buy: isBuy,
            sz: currencySize.toString(),
            limit_px: orderPrice,
            order_type: { limit: { tif: 'Gtc' } },
            reduce_only: false
        }]
    });

    // Handle main order status and get entry price
    const mainOrderStatus = mainOrderResult.response.data.statuses[0];
    let entryPrice;
    
    // Update mainOrderId immediately to prevent race conditions with fill events
    if (mainOrderStatus.filled) {
        config.position[pair].mainOrderId = mainOrderStatus.filled.oid;
        entryPrice = Number(mainOrderStatus.filled.avgPx);
    } else if (mainOrderStatus.resting) {
        config.position[pair].mainOrderId = mainOrderStatus.resting.oid;
        entryPrice = orderPrice;
    }

    // Calculate take profit and stop loss levels
    const takeProfitDistance = entryPrice * pairConfig.takeProfitPercentage;
    const stopLossDistance = takeProfitDistance / pairConfig.riskRewardRatio;

    const stopLossPrice = isBuy ?
        Number((entryPrice - stopLossDistance).toFixed(pairConfig.priceDecimals)) :
        Number((entryPrice + stopLossDistance).toFixed(pairConfig.priceDecimals));

    const takeProfitPrice = isBuy ?
        Number((entryPrice + takeProfitDistance).toFixed(pairConfig.priceDecimals)) :
        Number((entryPrice - takeProfitDistance).toFixed(pairConfig.priceDecimals));

    // Place stop loss order
    await sdk.exchange.placeOrder({
        orders: [{
            coin: pair,
            is_buy: !isBuy,
            sz: currencySize.toString(),
            limit_px: stopLossPrice,
            order_type: {
                trigger: {
                    isMarket: true,
                    triggerPx: stopLossPrice,
                    tpsl: "sl"
                }
            },
            reduce_only: true
        }]
    });

    // Place take profit order
    await sdk.exchange.placeOrder({
        orders: [{
            coin: pair,
            is_buy: !isBuy,
            sz: currencySize.toString(),
            limit_px: takeProfitPrice,
            order_type: {
                trigger: {
                    isMarket: true,
                    triggerPx: takeProfitPrice,
                    tpsl: "tp"
                }
            },
            reduce_only: true
        }]
    });

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
            if (!config.position[pair.pair].isInPosition) {
                await onCandle(pair, data);
            }
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
    placeOrder,
    updatePerformanceMetrics,
    initializeSubscriptions
}; 