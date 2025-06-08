const { Hyperliquid } = require('hyperliquid');
require("dotenv").config();

async function main() {

    // Calculate grid parameters
    const baseGridSpacing = 0.003; // 0.2% base spacing
    const orderSize = 1.2;
    const numGrids = 10; // Number of grids above and below current price
    const exponentialFactor = 1.1; // Factor to increase spacing exponentially

    // Initialize the Hyperliquid SDK
    const sdk = new Hyperliquid({
        privateKey: process.env.MAIN_PRIVATE_KEY,
        walletAddress: process.env.MAIN_API_ADDRESS,
        enableWs: true
    });

    // Connect to the WebSocket
    await sdk.connect();
    console.log('Connected to WebSocket');

    // Get updates anytime the user gets new fills
    sdk.subscriptions.subscribeToUserFills(process.env.MAIN_WALLET_ADDRESS, (data) => {
        if (!data.isSnapshot) {
            if (data.fills[0].side == 'buy') {

                // Place sell order
                sdk.exchange.placeOrder({
                    coin: data.fills[0].coin,
                    is_buy: false,
                    sz: orderSize,
                    limit_px: Number((data.fills[0].px * (1 + baseGridSpacing)).toFixed(2)),
                    order_type: { limit: { tif: 'Gtc' } },
                    reduce_only: false
                }).then(result => {
                    console.log(result);
                });

            } else if (data.fills[0].side == 'sell') {

                // Place buy order
                sdk.exchange.placeOrder({
                    coin: data.fills[0].coin,
                    is_buy: true,
                    sz: orderSize,
                    limit_px: Number((data.fills[0].px * (1 - baseGridSpacing)).toFixed(2)),
                    order_type: { limit: { tif: 'Gtc' } },
                    reduce_only: false
                }).then(result => {
                    console.log(result);
                });
            }
        }
    });

    // Get current market price for HYPE
    const l2Book = await sdk.info.getL2Book('HYPE-PERP');
    const currentPrice = parseFloat(l2Book.levels[0][0].px);

    // Calculate grid prices
    const gridPrices = [];
    
    // Calculate buy orders prices (linear spacing)
    for (let i = 1; i <= numGrids; i++) {
        const price = currentPrice * (1 - i * baseGridSpacing);
        gridPrices.push(Number(price.toFixed(2)));
    }
    
    // Calculate sell orders prices (exponential spacing)
    for (let i = 1; i <= numGrids; i++) {
        const spacing = baseGridSpacing * Math.pow(exponentialFactor, i - 1);
        const price = currentPrice * (1 + i * spacing);
        gridPrices.push(Number(price.toFixed(2)));
    }

    // Create an array to store all order promises
    const orderPromises = [];

    // Place grid orders
    for (const price of gridPrices) {
        // Place buy order if price is below current price
        if (price < currentPrice) {
            const orderPromise = sdk.exchange.placeOrder({
                coin: 'HYPE-PERP',
                is_buy: true,
                sz: orderSize,
                limit_px: price,
                order_type: { limit: { tif: 'Gtc' } },
                reduce_only: false
            }).then(result => {
                console.log(result);
            });
            orderPromises.push(orderPromise);
        }
        // Place sell order if price is above current price
        else if (price > currentPrice) {
            const orderPromise = sdk.exchange.placeOrder({
                coin: 'HYPE-PERP',
                is_buy: false,
                sz: orderSize,
                limit_px: price,
                order_type: { limit: { tif: 'Gtc' } },
                reduce_only: false
            }).then(result => {
                console.log(result);
            });
            orderPromises.push(orderPromise);
        }
    }

    // Wait for all orders to be placed
    await Promise.all(orderPromises);

    // Now check open orders after all orders are placed
    const userOpenOrders = await sdk.info.getUserOpenOrders(process.env.MAIN_WALLET_ADDRESS);
    console.log('Open orders:', userOpenOrders);
}

main()