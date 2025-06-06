const technicalIndicators = require('technicalindicators');
require("dotenv").config();

const baseConfig = require('./config/baseConfig');
const {
    initializeSDK,
    fetchCandleData,
    placeOrder,
    updatePerformanceMetrics,
    initializeSubscriptions
} = require('./config/utils');

async function main() {
    // Initialize the Hyperliquid SDK
    const sdk = await initializeSDK();
    await sdk.connect();

    // Strategy specific configuration
    const config = {
        ...baseConfig,
        indicators: {
            rsiPeriod: 10,
            rsiOverbought: 0, // 60
            rsiOversold: 100, // 40
            smaPeriod: 15
        }
    };

    // Function to calculate RSI
    function calculateRSI(candles) {
        const prices = candles.map(candle => parseFloat(candle.c));
        const rsi = technicalIndicators.RSI.calculate({
            values: prices,
            period: config.indicators.rsiPeriod
        });
        return rsi[rsi.length - 1];
    }

    // Function to calculate SMA
    function calculateSMA(candles) {
        const prices = candles.map(candle => parseFloat(candle.c));
        const sma = technicalIndicators.SMA.calculate({
            values: prices,
            period: config.indicators.smaPeriod
        });
        return sma[sma.length - 1];
    }

    // Initialize data for all pairs
    for (const pair of config.trading.pairs) {
        const candles = await fetchCandleData(sdk, pair.coin, config.candles.interval, config.candles.count);
        config.history[pair.pair].candles = candles;
        config.history[pair.pair].lastCandleTime = candles[candles.length - 1].t;
    }

    // Handle candle updates
    async function handleCandle(pair, data) {
        if (!data.isSnapshot) {
            const currentCandleTime = data.t;

            if (currentCandleTime > config.history[pair.pair].lastCandleTime) {
                config.history[pair.pair].lastCandleTime = currentCandleTime;
                config.history[pair.pair].candles.push(data);
                config.history[pair.pair].candles.shift();
            } else if (currentCandleTime == config.history[pair.pair].lastCandleTime) {
                config.history[pair.pair].candles[config.history[pair.pair].candles.length - 1] = data;
            }

            // Only proceed if we are not in a position
            if (!config.position[pair.pair].isInPosition) {
                const currentPrice = parseFloat(data.c);
                const rsi = calculateRSI(config.history[pair.pair].candles);
                const sma = calculateSMA(config.history[pair.pair].candles);

                // Trading logic
                if (rsi < config.indicators.rsiOversold && currentPrice > sma) {
                    config.position[pair.pair].isInPosition = true;
                    await placeOrder(sdk, config, pair.pair, true);
                } else if (rsi > config.indicators.rsiOverbought && currentPrice < sma) {
                    config.position[pair.pair].isInPosition = true;
                    await placeOrder(sdk, config, pair.pair, false);
                }
            }
        }
    }

    // Handle fill updates
    async function handleFill(pair, fill) {
        if (config.position[pair].isInPosition && 
            fill.oid != config.position[pair].mainOrderId) {
            
            config.position[pair].isInPosition = false;
            updatePerformanceMetrics(config, pair, fill);
        }
    }

    // Initialize subscriptions for all pairs
    await initializeSubscriptions(sdk, config, handleCandle, handleFill);
}

main().catch(console.error); 