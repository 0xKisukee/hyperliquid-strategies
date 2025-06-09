const technicalIndicators = require('technicalindicators');
require("dotenv").config();

const {
    initializeSDK
} = require('../config/utils');

const pair = 'ETH-PERP';
const side = "S"; // B = Buy, S = Sell
const usdValue = 5000;
const sizeDecimals = 4;
const priceDecimals = 1;

async function main() {
    // Initialize the Hyperliquid SDK
    const sdk = await initializeSDK();
    await sdk.connect();

    let isBuy;
    if (side === "B") {
        isBuy = true;
    } else {
        isBuy = false;
    }

    const l2Book = await sdk.info.getL2Book(pair);
    let orderPrice = side === "B" ?
        parseFloat(l2Book.levels[0][0].px) :
        parseFloat(l2Book.levels[1][0].px);

    const stopLossPrice = isBuy ?
        Number((orderPrice * 0.998).toFixed(priceDecimals)) :
        Number((orderPrice * 1.002).toFixed(priceDecimals));

    const takeProfitPrice = isBuy ?
        Number((orderPrice * 1.005).toFixed(priceDecimals)) :
        Number((orderPrice * 0.995).toFixed(priceDecimals));

    const currencySize = Number((usdValue / orderPrice).toFixed(sizeDecimals));
    orderPrice = Number(orderPrice.toFixed(priceDecimals));

    await sdk.exchange.placeOrder({
        coin: pair,
        is_buy: isBuy,
        sz: currencySize.toString(),
        limit_px: orderPrice.toString(),
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: false
    });

    // Place stop loss order
    await sdk.exchange.placeOrder({
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
    });

    // Place take profit order
    await sdk.exchange.placeOrder({
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
    });
}

main().catch(console.error); 