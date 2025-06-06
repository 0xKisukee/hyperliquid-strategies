const { Hyperliquid } = require('hyperliquid');
const technicalIndicators = require('technicalindicators');
require("dotenv").config();

async function main() {
    // Initialize the Hyperliquid SDK
    const sdk = new Hyperliquid({
        privateKey: process.env.MAIN_PRIVATE_KEY,
        walletAddress: process.env.MAIN_API_ADDRESS,
        enableWs: true
    });

    // Connect to the WebSocket
    await sdk.connect();

    // Trading parameters
    const coin = 'ETH';
    const pair = coin + '-PERP';
    const positionSize = 30; // Size of each trade IN USD
    const takeProfitPercentage = 0.005; // 0.5% take profit
    const riskRewardRatio = 2; // 2:1 risk-reward ratio

    const candleInterval = '1m'; // 1 minute candles
    const candleCount = 50;

    const rsiPeriod = 10;
    const rsiOverbought = 0; // 60
    const rsiOversold = 100; // 40
    const smaPeriod = 15;

    let totalTrades = 0;
    let totalWins = 0;
    let totalLosses = 0;
    let totalPnl = 0;

    // Store historical prices for indicators
    let priceHistory = [];
    let isInPosition = false;
    let mainOrderId = null;

    // Function to fetch candle data using WebSocket
    async function fetchCandleData() {
        const endTime = Date.now();
        const startTime = endTime - (candleCount * 60 * 1000); // 100 minutes ago

        const response = await sdk.subscriptions.postRequest('info', {
            type: 'candleSnapshot',
            req: {
                coin: coin,
                interval: candleInterval,
                startTime: startTime,
                endTime: endTime
            }
        });

        return response.data;
    }

    // Function to calculate RSI
    function calculateRSI(prices) {
        const rsi = technicalIndicators.RSI.calculate({
            values: prices,
            period: rsiPeriod
        });
        return rsi[rsi.length - 1];
    }

    // Function to calculate SMA
    function calculateSMA(prices) {
        const sma = technicalIndicators.SMA.calculate({
            values: prices,
            period: smaPeriod
        });
        return sma[sma.length - 1];
    }

    // Function to get decimal precision for a pair
    async function getDecimalPrecision(pair) {
        const meta = await sdk.info.perpetuals.getMeta();
        const asset = meta.universe.find(asset => asset.name === pair);
        
        if (!asset) {
            return {
                sizeDecimals: 4,
                maxPriceDecimals: 6
            };
        }

        // For perps, MAX_DECIMALS is 6
        const MAX_DECIMALS = 6;
        const maxPriceDecimals = Math.min(5, MAX_DECIMALS - asset.szDecimals);
        
        return {
            sizeDecimals: asset.szDecimals,
            maxPriceDecimals: maxPriceDecimals
        };
    }

    // Function to format price according to precision rules
    function formatPrice(price) {
        // If it's an integer, return as is
        if (Number.isInteger(price)) {
            return price.toString();
        }

        // Get the number of significant figures
        const significantFigures = price.toString().replace(/^0+\.?|\./g, '').length;
        
        // If more than 5 significant figures, round to 5
        if (significantFigures > 5) {
            return price.toPrecision(5);
        }

        return price.toString();
    }

    // Function to place orders with stop loss and take profit
    async function placeOrderWithRiskManagement(isBuy) {
        const l2Book = await sdk.info.getL2Book(pair);

        // below i am using the 2nd best price in the book, be careful on pair with big spread
        const entryPrice = isBuy ? parseFloat(l2Book.levels[1][2].px) : parseFloat(l2Book.levels[0][2].px)
        
        // Get decimal precision for the pair
        const { sizeDecimals, maxPriceDecimals } = await getDecimalPrecision(pair);
        
        // Convert USD position size to currency size with correct decimal precision
        const currencySize = Number((positionSize / entryPrice).toFixed(sizeDecimals));
        
        const takeProfitDistance = entryPrice * takeProfitPercentage;
        const stopLossDistance = takeProfitDistance / riskRewardRatio;

        const stopLossPrice = isBuy ?
            Number((entryPrice - stopLossDistance).toFixed(maxPriceDecimals)) :
            Number((entryPrice + stopLossDistance).toFixed(maxPriceDecimals));

        const takeProfitPrice = isBuy ?
            Number((entryPrice + takeProfitDistance).toFixed(maxPriceDecimals)) :
            Number((entryPrice - takeProfitDistance).toFixed(maxPriceDecimals));

        sdk.exchange.placeOrder({
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
        }).then(placeOrderResult => {            
            // Handle both resting and filled order statuses
            const mainOrderStatus = placeOrderResult.response.data.statuses[0];
            if (mainOrderStatus.filled) {
                mainOrderId = mainOrderStatus.filled.oid;
            } else if (mainOrderStatus.resting) {
                mainOrderId = mainOrderStatus.resting.oid;
            }
        }).catch(error => {
            console.error('Error placing order:', error);
        });
    }

    // Initial candle data fetch
    let candles = await fetchCandleData();

    // Process initial candles
    priceHistory = candles.map(candle => parseFloat(candle.c)); // Using close prices

    // Save last candle open time
    let lastCandleTime = candles[candles.length - 1].t;

    // Subscribe to new candles
    sdk.subscriptions.subscribeToCandle(pair, candleInterval, async (data) => {
        if (!data.isSnapshot) {
            const currentPrice = parseFloat(data.c); // Using close price
            const currentCandleTime = data.t;

            if (currentCandleTime > lastCandleTime) {
                lastCandleTime = currentCandleTime;
                priceHistory.push(currentPrice); // Still use close price for indicators
                priceHistory.shift();
            } else if (currentCandleTime == lastCandleTime) {
                priceHistory[priceHistory.length - 1] = currentPrice;
            }

            // Only proceed if we have enough data and not in a position
            if (!isInPosition) {
                const rsi = calculateRSI(priceHistory);
                const sma = calculateSMA(priceHistory);

                // Trading logic
                if (rsi < rsiOversold && currentPrice > sma) {
                    // Potential buy signal - price above SMA in uptrend, RSI oversold
                    console.log('Buy signal detected:'/*, {
                        rsi,
                        sma,
                        currentPrice,
                        candle: data
                    }*/);
                    
                    isInPosition = true;
                    await placeOrderWithRiskManagement(true);
                } else if (rsi > rsiOverbought && currentPrice < sma) {
                    // Potential sell signal - price below SMA in downtrend, RSI overbought
                    console.log('Sell signal detected:'/*, {
                        rsi,
                        sma,
                        currentPrice,
                        candle: data
                    }*/);

                    isInPosition = true;
                    await placeOrderWithRiskManagement(false);
                }
            }
        }
    });

    // Subscribe to user fills to track position exits
    sdk.subscriptions.subscribeToUserFills(process.env.MAIN_WALLET_ADDRESS, async (data) => {
        if (!data.isSnapshot && isInPosition && data.fills[0].oid != mainOrderId && data.fills[0].coin == pair) {
            // console.log("filled order: ", data.fills);
            isInPosition = false;

            totalTrades++;

            if (data.fills[0].closedPnl > 0) {
                totalWins++;
            } else if (data.fills[0].closedPnl < 0) {
                totalLosses++;
            }

            for (const fill of data.fills) {
                totalPnl = totalPnl + fill.closedPnl - fill.fee;
            }

            console.log("accrued pnl: ", totalPnl, "total trades: ", totalTrades, "total wins: ", totalWins, "total losses: ", totalLosses);
        }
    });

}

main().catch(console.error); 