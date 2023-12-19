require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Web3 = require('web3');
const axios = require('axios');
const cron = require('node-cron');
const mongoose = require('mongoose');
const PODGameABI = require('./podgameabi.json'); // ABI of the PODGame contract

const app = express();
app.use(cors({
    origin: 'http://localhost:3000' // allow only the React app to access
  }));
  

const port = process.env.PORT

// Ethereum node URL and smart contract details
const nodeUrl = process.env.RPC_URL;
const contractAddress = process.env.POD_GAME_ADDRESS;

// MongoDB setup
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('Could not connect to MongoDB:', err));

const betSchema = new mongoose.Schema({
    betId: Number,
    finder: String,
    tokenAddress: String, // Add this line
    startTime: Date,
    totalBetAmount: Number,
    initialPrice: Number,
    finalPrice: Number,
    settled: Boolean,
    outcome: String // 'Pump', 'Dump', or 'No Change'
});
const Bet = mongoose.model('Bet', betSchema);

// Initialize web3 and contract
const web3 = new Web3(new Web3.providers.WebsocketProvider(nodeUrl));
const contract = new web3.eth.Contract(PODGameABI, process.env.POD_GAME_ADDRESS); // Address of the deployed PODGame contract
const devWalletAccount = web3.eth.accounts.privateKeyToAccount(process.env.DEV_WALLET_PRIVATE_KEY);
web3.eth.accounts.wallet.add(devWalletAccount);

// Event listener for new bets
contract.events.BetInitialized({
    fromBlock: 'latest'
}, function(error, event) {
    if (error) {
        console.error("Error in event listener:", error);
    } else {
        handleNewBetEvent(event.returnValues);
    }
});

async function handleNewBetEvent(betData) {
    try {
        const newBet = new Bet({
            betId: betData.betId,
            finder: betData.finder,
            tokenAddress: betData.tokenAddress, // Save token address
            startTime: new Date(),
            totalBetAmount: betData.betAmount,
            initialPrice: null,
            finalPrice: null,
            settled: false,
            outcome: null
        });
        await newBet.save();
        console.log("New bet saved to DB:", betData.betId);

        // Schedule price checks
        setTimeout(() => fetchPriceAndUpdateBet(betData.tokenAddress, betData.betId, "initialPrice"), 5 * 60 * 1000); // After 15 minutes
        setTimeout(() => fetchPriceAndUpdateBet(betData.tokenAddress, betData.betId, "finalPrice"), 11 * 60 * 1000); // After 45 minutes in total
    } catch (error) {
        console.error("Error saving bet to DB:", error);
    }
}

const fetchPrice = async (tokenAddress) => {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        const priceUsd = response.data.pairs && response.data.pairs[0] ? response.data.pairs[0].priceUsd : null;
        console.log(`Fetched price for ${tokenAddress}: ${priceUsd}`);
        return priceUsd;
    } catch (error) {
        console.error('Error fetching price:', error);
        return null;
    }
};

async function fetchPriceAndUpdateBet(tokenAddress, betId, priceKey) {
    const price = await fetchPrice(tokenAddress);
    if (price !== null) {
        await Bet.updateOne({ betId }, { $set: { [priceKey]: price } });
        if (priceKey === "finalPrice") {
            // Determine outcome and call settleBet
            const bet = await Bet.findOne({ betId });
            const outcome = determineOutcome(bet.initialPrice, bet.finalPrice); 

            // Log the calculated outcome for user feedback
            console.log(`Outcome for bet ${betId} is ${outcome}`);

            settleBet(betId, outcome);
        }
    }
}

function determineOutcome(initialPrice, finalPrice) {
    const priceChange = finalPrice - initialPrice;
    const threshold = 0.00; // Define a threshold for 'No Change', adjust as needed

    if (priceChange > threshold) {
        return true;  // Pump
    } else if (priceChange < -threshold) {
        return false; // Dump
    } else {
        return null;  // No Change
    }
}

// GET route to fetch bet details
app.get('/api/bet/:betId', async (req, res) => {
    try {
        const betId = parseInt(req.params.betId); // Ensure the bet ID is a number
        const bet = await Bet.findOne({ betId });

        if (!bet) {
            return res.status(404).send('Bet not found.');
        }

        // Combine all needed data into a single object
        const responseData = {
            betId: bet.betId,
            finder: bet.finder,
            startTime: bet.startTime,
            tokenAddress: bet.tokenAddress, // Add this line
            totalBetAmount: bet.totalBetAmount,
            initialPrice: bet.initialPrice,
            finalPrice: bet.finalPrice,
            settled: bet.settled,
            outcome: bet.outcome
        };

        res.send(responseData);

    } catch (error) {
        console.error('Error fetching bet details:', error);
        res.status(500).send('Internal Server Error');
    }
});

async function settleBet(betId, outcome) {
    let txData;

    if (outcome === null) {
        console.log(`No change in price for bet ${betId}, settling with no change.`);
        txData = contract.methods.settleBetNoChange(betId).encodeABI();
    } else {
        txData = contract.methods.settleBet(betId, outcome).encodeABI();
    }

    try {
        // Estimate gas with a buffer
        console.log('Estimating gas for the transaction...');
        const gasEstimate = await web3.eth.estimateGas({
            from: devWalletAccount.address,
            to: contractAddress,
            data: txData
        });
        console.log('Estimated gas:', gasEstimate);

        const gasBuffer = Math.floor(gasEstimate * 0.1); // Calculate 10% buffer
        const gasWithBuffer = gasEstimate + gasBuffer;

        // Get current gas price
        console.log('Fetching current gas price...');
        const gasPrice = await web3.eth.getGasPrice();
        console.log('Current gas price:', gasPrice);

        // Transaction object
        const tx = {
            from: devWalletAccount.address,
            to: contractAddress,
            data: txData,
            gas: gasWithBuffer,
            gasPrice: gasPrice
        };

        // Sign and send the transaction
        console.log('Sending from address:', devWalletAccount.address);
        const signedTx = await web3.eth.accounts.signTransaction(tx, devWalletAccount.privateKey);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

        console.log("Bet settled:", receipt);
    } catch (error) {
        console.error("Error settling bet:", error);
    }
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
