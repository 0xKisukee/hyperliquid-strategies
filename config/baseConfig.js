// Base configuration for all trading strategies
const baseConfig = {
    // Trading pairs configuration
    trading: {
        pairs: [
            {
                coin: 'ETH',
                pair: 'ETH-PERP',
                positionSize: 50, // Size of each trade in USD
                takeProfitPercentage: 0.005, // 0.5% take profit
                riskRewardRatio: 2, // Risk-reward ratio
                priceDecimals: 1, // Maximum decimal places for price
                sizeDecimals: 4, // Maximum decimal places for size
            },
            {
                coin: 'BTC',
                pair: 'BTC-PERP',
                positionSize: 50, // Size of each trade in USD
                takeProfitPercentage: 0.004, // 0.5% take profit
                riskRewardRatio: 2, // Risk-reward ratio
                priceDecimals: 0, // Maximum decimal places for price
                sizeDecimals: 5, // Maximum decimal places for size
            }
        ],
    },

    // Candle configuration
    candles: {
        interval: '1m', // 1 minute candles
        count: 100, // Number of candles to keep in history
    },

    // Performance tracking per pair
    tracking: {}, // Will be populated dynamically for each pair

    // Position tracking per pair
    position: {}, // Will be populated dynamically for each pair

    // Candle history per pair
    history: {}, // Will be populated dynamically for each pair
};

// Initialize tracking, position, and history for each pair
baseConfig.trading.pairs.forEach(pair => {
    baseConfig.tracking[pair.pair] = {
        totalTrades: 0,
        totalWins: 0,
        totalLosses: 0,
        totalPnl: 0,
    };

    baseConfig.position[pair.pair] = {
        isInPosition: false,
        mainOrderId: null,
    };

    baseConfig.history[pair.pair] = {
        candles: [], // Store complete candle data
        lastCandleTime: null,
    };
});

module.exports = baseConfig; 