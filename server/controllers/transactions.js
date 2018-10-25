const { Transaction, Wallet, TokenType, Challenge } = require('../models');
const nacl = require("tweetnacl");
const StellarSdk = require("stellar-sdk");
const dec = require("../utils/dec");
const TOKEN_GRAVEYARD_ADDRESS = process.env.TOKEN_GRAVEYARD_ADDRESS;
// Receives: publicKey, tokenTypeUuid
// Returns: oldest transaction of a wallet that has no child transactions
const getOldestTransaction = async (publicKey, tokenTypeUuid) => {
  const parentTransactionUuids = new Set();

  const givenTransactions = await Transaction.findAll({
    where: { fromAddress: publicKey, tokenTypeUuid}
  });
  givenTransactions.forEach((transaction) => {
    parentTransactionUuids.add(transaction.parentTransaction);
  });
  const receivedTransactions = await Transaction.findAll({
    where: { toAddress: publicKey, tokenTypeUuid},
    order: [["updatedAt", "DESC"]] // newest to oldest
  });
  for (let i = receivedTransactions.length - 1; i >= 0; i--) {
    const transaction = receivedTransactions[i];
    if (!parentTransactionUuids.has(transaction.uuid)) {
      return transaction;
    }
  }
};
// Receives: Any transaction
// Returns: chain of transactions from initial challenge to given transaction
  // Order: (challenge -> ... -> transaction)
const getProvenanceChain = async (transaction) => {
  const transactionChain = []; 
  do {
      transactionChain.unshift(transaction);
      transaction = await Transaction.findById(transaction.parentTransaction);
  } while (transaction);
  return transactionChain;
};

const getChildrenTransactions = async (parentTransaction) => {
  return await Transaction.findAll({
    where: { parentTransaction }
  });
};

// Receives: publicKey as string, signed transaction, unsigned transaction
// Returns: Boolean: Was this signed by publicKey's secret key
const isVerified = (publicKeyStr, signed, reconstructedObject) => {
  const walletBuffer = StellarSdk.StrKey.decodeEd25519PublicKey(publicKeyStr);
  const decodedObject = dec(JSON.stringify(reconstructedObject));
  return nacl.sign.detached.verify(
    decodedObject,
    Uint8Array.from(JSON.parse(signed)),
    walletBuffer
  );
};

const transactionsController = {
  // GET ()
    // -> [{transactionData}...{transactionData}]
  async list(_, res) {
    try {
        const allTransactions = await Transaction.findAll({});
        res.status(200).send(allTransactions);
    } catch(error) { res.status(400).send(error); }
  },
  // POST (params: {walletUuid, tokenTypeUuid}, body: {amount, signed})
    // -> createdTransaction // this is just the "challenge" issued to creator
  async create({body, params}, res) {
    const { address, challengeUuid } = params;
    const signed = body.signed;
    const amount = parseInt(body.amount, 10);
    const wallet = await Wallet.findOne({ where: { address } });
    if (!wallet) {
      return res.status(404).send({ message: "Wallet not found" });
    }
    const challenge = await Challenge.findById(challengeUuid);
    if (!challenge) {
      return res.status(404).send({ message: "Challenge not found" });
    }
    if (challenge.sponsorWalletAddress !== address) {
      return res.status(404).send({message:"Wallet !== Challenge sponsor"});
    }
    const reconstructedObject = { amount };
    if (!isVerified(address, signed, reconstructedObject)) {
      return res.status(403).send({ message: "Invalid transaction signing" });
    }
    const transaction = await Transaction.create({
      amount,
      fromAddress: address,
      toAddress: address,
      challengeUuid
    });
    res.status(200).send(transaction);
  },
  //POST (params: {transactionUuid}, body: {fromAddress, toAddress, signed})
    // -> transaction between fromAddress and toAddress, transferring "challenge"
  async share({ body, params }, res) {
    const { challengeUuid } = params;
    const { fromAddress, toAddress, signed } = body;
    const challenge = await Challenge.findOne({where: {uuid: challengeUuid}, include: [{model: Transaction, as: 'transactions'}]});
    const lastTransaction = challenge.transactions[challenge.transactions.length - 1];
    if (!challenge) {
      return res.status(404).send({ message: "Challenge not found" });
    }
    if (fromAddress !== lastTransaction.toAddress && fromAddress !== challenge.sponsorWalletAddress) {
      return res.status(403).send({ message: "Unauthorized transfer" });
    }
    if (fromAddress !== challenge.sponsorWalletAddress) {
        const childrenTransactions = await getChildrenTransactions(lastTransaction.uuid);
        if (childrenTransactions.length > 0) {
            return res.status(403).send({ message: "Transaction was transferred already" });
        }
    }
    let fromWallet = await Wallet.findOne({ where: { address: fromAddress } });
    if (!fromWallet) {
      return res.status(404).send({ message: "Invalid fromAddress" });
    }
    let toWallet = await Wallet.findOne({ where: { address: toAddress } });
    if (!toWallet) {
      toWallet = await Wallet.create({ address: toAddress });
    }
    const reconstructedObject = { fromAddress, toAddress };
    if (!isVerified(fromAddress, signed, reconstructedObject)) {
      return res.status(403).send({ message: "Invalid transaction signing" });
    }
    const newTransaction = await Transaction.create({
      toAddress,
      fromAddress,
      amount: challenge.rewardAmount,
      parentTransaction: lastTransaction.uuid,
      challengeUuid
    });
    const data = { fromWallet, toWallet, transaction: newTransaction };
    res.status(200).send(data);
  },
  // GET (params: {transactionUuid})
    // -> [challengeTransaction, transaction2...transaction]
    // array of transactions leading to transaction w/ transactionUuid
  async provenanceChain({params}, res) {
    let transaction = await Transaction.findById(params.transactionUuid);
    if (!transaction) {
      return res.status(404).send({ message: "transactionUuid is invalid" });
    }
    if (transaction.toAddress === transaction.fromAddress) {
      return res.status(400).send({ message: "Challenge has no provenance" });
    }
    const transactionChain = await getProvenanceChain(transaction);
    res.status(200).send(transactionChain);
  },
  // GET (params: {walletUuid, tokenTypeUuid})
    // -> [challengeTransaction, transaction2...transaction]
    // returns provenanceChain of oldest "challenge" that hasn't been shared
  async provenanceChainFIFO({params}, res) {
    const { address, tokenTypeUuid } = params;
    const wallet = await Wallet.findOne({ where: { address } });
    if (!wallet) {
      return res.status(404).send({ message: "Wallet not found" });
    }
    const tokenType = await TokenType.findById(tokenTypeUuid);
    if (!tokenType) {
      return res.status(404).send({ message: "TokenType not found" });
    }
    const oldestOwnedTransaction = await getOldestTransaction(
      address, tokenTypeUuid
    );
    if (!oldestOwnedTransaction) {
      return res.status(404).send({ message: "No owned challenges" });
    }
    const transactionChain = await getProvenanceChain(oldestOwnedTransaction);
    res.status(200).send(transactionChain);
  },
  // POST (body: { transactionUuid, signed })
  // -> transaction w/ tokenGraveyard
  async redeem({body}, res) {
    const { challengeUuid, signed } = body;
    const challenge = await Challenge.findOne({where: {uuid: challengeUuid}, include: [{model: Transaction, as: 'transactions'}]});
    if (!challenge) {
      return res.status(404).send({ message: "Challenge not found" });
    }
    const tokenType = await TokenType.findById(challenge.tokenTypeUuid);
    const reconstructedObject = { challengeUuid };
    if (!isVerified(tokenType.sponsorUuid, signed, reconstructedObject)) {
      return res.status(403).send({
        message: "Only the TokenType sponsor can trigger redemption"
      });
    }
    const toAddress = challenge.transactions[challenge.transactions.length - 1].toAddress;
    let redeemWallet = await Wallet.findOne({ where: { address: toAddress } });
    const newTransaction = await Transaction.create({
      fromAddress: toAddress,
      toAddress: TOKEN_GRAVEYARD_ADDRESS,
      amount: challenge.rewardAmount,
      challengeUuid: challenge.uuid,
      parentTransaction: challenge.transactions[challenge.transactions.length - 1].uuid
    });
    const redeemedChallenge = await challenge.update({isRedeemed: true});
    const sponsoredChallenges = await Challenge.findAll({where: {sponsorWalletAddress: challenge.sponsorWalletAddress, isRedeemed: false}});
    const heldChallenges = [];
    const allChallenges = await Challenge.findAll({where: {isRedeemed: false}, include: [{model: Transaction, as: 'transactions'}]});
    allChallenges.forEach(challenge => {
        if (challenge.transactions.length > 1 && challenge.transactions[challenge.transactions.length - 1].toAddress === challenge.sponsorWalletAddress) {
            heldChallenges.push(challenge);
        }
    });
    res.status(200).send({sponsoredChallenges, heldChallenges, redeemTransaction: newTransaction});
  }
};

module.exports = transactionsController;