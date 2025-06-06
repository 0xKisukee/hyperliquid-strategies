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
    const positionSize = 100; // Size of each trade IN USD
    const takeProfitPercentage = 0.005; // 0.5% take profit
    const riskRewardRatio = 2; // Risk-reward ratio

    const candleInterval = '1m'; // 1 minute candles
    const candleCount = 100; // Increased to ensure enough data for EMA 90

    // PSAR parameters
    const psarStep = 0.02; // Step size
    const psarMax = 0.2; // Maximum step size
    const emaPeriod = 90; // EMA period

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
        const startTime = endTime - (candleCount * 60 * 1000);

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

    // Function to calculate PSAR
    function calculatePSAR(highs, lows) {
        const psar = technicalIndicators.PSAR.calculate({
            high: highs,
            low: lows,
            step: psarStep,
            max: psarMax
        });
        return psar[psar.length - 1];
    }

    // Function to calculate EMA
    function calculateEMA(prices) {
        const ema = technicalIndicators.EMA.calculate({
            values: prices,
            period: emaPeriod
        });
        return ema[ema.length - 1];
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

        const MAX_DECIMALS = 6;
        const maxPriceDecimals = Math.min(5, MAX_DECIMALS - asset.szDecimals);
        
        return {
            sizeDecimals: asset.szDecimals,
            maxPriceDecimals: maxPriceDecimals
        };
    }

    // Function to format price according to precision rules
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

    // Function to place orders with stop loss and take profit
    async function placeOrderWithRiskManagement(isBuy) {
        const l2Book = await sdk.info.getL2Book(pair);

        // below i am using the 2nd best price in the book, be careful on pair with big spread
        const entryPrice = isBuy ? parseFloat(l2Book.levels[1][2].px) : parseFloat(l2Book.levels[0][2].px)
        
        const { sizeDecimals, maxPriceDecimals } = await getDecimalPrecision(pair);
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
    const highs = candles.map(candle => parseFloat(candle.h));
    const lows = candles.map(candle => parseFloat(candle.l));
    priceHistory = candles.map(candle => parseFloat(candle.c));

    // Save last candle open time
    let lastCandleTime = candles[candles.length - 1].t;

    // Subscribe to new candles
    sdk.subscriptions.subscribeToCandle(pair, candleInterval, async (data) => {
        if (!data.isSnapshot) {
            const currentPrice = parseFloat(data.c);
            const currentHigh = parseFloat(data.h);
            const currentLow = parseFloat(data.l);
            const currentCandleTime = data.t;

            if (currentCandleTime > lastCandleTime) {
                lastCandleTime = currentCandleTime;
                highs.push(currentHigh);
                highs.shift();
                lows.push(currentLow);
                lows.shift();
                priceHistory.push(currentPrice);
                priceHistory.shift();
            } else if (currentCandleTime == lastCandleTime) {
                highs[highs.length - 1] = currentHigh;
                lows[lows.length - 1] = currentLow;
                priceHistory[priceHistory.length - 1] = currentPrice;
            }

            // Only proceed if we have enough data and not in a position
            if (!isInPosition) {
                const psar = calculatePSAR(highs, lows);
                const ema = calculateEMA(priceHistory);

                // Trading logic based on PSAR and EMA
                if (currentPrice > psar && currentPrice > ema) {
                    // PSAR below price and price above EMA - potential buy signal
                    console.log('Buy signal detected:', {
                        price: currentPrice,
                        psar: psar,
                        ema: ema
                    });
                    
                    isInPosition = true;
                    await placeOrderWithRiskManagement(true);
                } else if (currentPrice < psar && currentPrice < ema) {
                    // PSAR above price and price below EMA - potential sell signal
                    console.log('Sell signal detected:', {
                        price: currentPrice,
                        psar: psar,
                        ema: ema
                    });

                    isInPosition = true;
                    await placeOrderWithRiskManagement(false);
                }
            }
        }
    });

    // Subscribe to user fills to track position exits
    sdk.subscriptions.subscribeToUserFills(process.env.MAIN_WALLET_ADDRESS, async (data) => {
        if (!data.isSnapshot && isInPosition && data.fills[0].oid != mainOrderId && data.fills[0].coin == pair) {
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