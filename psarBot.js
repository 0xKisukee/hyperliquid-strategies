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
            psarStep: 0.02, // Step size
            psarMax: 0.2, // Maximum step size
            emaPeriod: 90 // EMA period
        }
    };

    // Function to calculate PSAR
    function calculatePSAR(candles) {
        const highs = candles.map(candle => parseFloat(candle.h));
        const lows = candles.map(candle => parseFloat(candle.l));
        const psar = technicalIndicators.PSAR.calculate({
            high: highs,
            low: lows,
            step: config.indicators.psarStep,
            max: config.indicators.psarMax
        });
        return psar[psar.length - 1];
    }

    // Function to calculate EMA
    function calculateEMA(candles) {
        const prices = candles.map(candle => parseFloat(candle.c));
        const ema = technicalIndicators.EMA.calculate({
            values: prices,
            period: config.indicators.emaPeriod
        });
        return ema[ema.length - 1];
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

            const currentPrice = parseFloat(data.c);
            const psar = calculatePSAR(config.history[pair.pair].candles);
            const ema = calculateEMA(config.history[pair.pair].candles);

            // Trading logic based on PSAR and EMA
            if (currentPrice > psar /*&& currentPrice > ema*/) {
                config.position[pair.pair].isInPosition = true;
                console.log('GONNA PLACE ORDER SO IN POSITION');
                await placeOrder(sdk, config, pair.pair, true);
            } else if (currentPrice < psar /*&& currentPrice < ema*/) {
                config.position[pair.pair].isInPosition = true;
                console.log('GONNA PLACE ORDER SO IN POSITION');
                await placeOrder(sdk, config, pair.pair, false);
            }
        }
    }

    // Handle fill updates
    async function handleFill(pair, fill) {
        if (config.position[pair].isInPosition && 
            fill.oid != config.position[pair].mainOrderId) {

            console.log('filled order: ', fill);
            console.log('isInPosition: ', config.position[pair].isInPosition);
            console.log('saved mainOrderId: ', config.position[pair].mainOrderId);
            
            config.position[pair].isInPosition = false;
            updatePerformanceMetrics(config, pair, fill);
        }
    }

    // Initialize subscriptions for all pairs
    await initializeSubscriptions(sdk, config, handleCandle, handleFill);
}

main().catch(console.error); 