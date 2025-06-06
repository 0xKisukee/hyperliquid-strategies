# Hyperliquid Trading Strategies

This repository contains automated trading strategies for the Hyperliquid exchange.

## Strategies

### 1. Scalping Bot
A scalping strategy that uses RSI and SMA indicators to identify short-term trading opportunities.

### 2. PSAR Bot
A trend-following strategy that uses Parabolic SAR and EMA indicators to identify trend reversals.

## Setup

1. Clone the repository
2. Install dependencies:
```bash
npm install
```
3. Create a `.env` file with your configuration:
```
MAIN_PRIVATE_KEY=your_private_key
MAIN_API_ADDRESS=your_api_address
MAIN_WALLET_ADDRESS=your_wallet_address
```

## Usage

Run the desired strategy:
```bash
node scalpingBot.js
# or
node psarBot.js
```

## Disclaimer

This software is for educational purposes only. Use at your own risk. The authors are not responsible for any financial losses incurred from using this software. 