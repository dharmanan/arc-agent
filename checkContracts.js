require('dotenv').config();
const { ethers } = require('ethers');

// Arc testnet RPC
const provider = new ethers.JsonRpcProvider("https://rpc.testnet.arc.network");

// .env adreslerini oku
const addresses = {
  curve: process.env.CURVE_POOL_ADDRESS,
  aave: process.env.AAVE_POOL_ADDRESS,
  band: process.env.BAND_REF_CONTRACT_ADDRESS,
  usdc: process.env.USDC_TOKEN_ADDRESS,
  eurc: process.env.EURC_TOKEN_ADDRESS
};

async function checkContracts() {
  for (const [name, address] of Object.entries(addresses)) {
    if (!address) {
      console.log(`${name} adresi .env içinde yok!`);
      continue;
    }

    // Adresin geçerli olup olmadığını kontrol et
    if (!ethers.isAddress(address)) {
      console.log(`${name} (${address}) geçerli bir adres değil!`);
      continue;
    }

    try {
      // getCode sadece address kullanır, ENS çözümlemesini devre dışı bırak
      const code = await provider.getCode(address);
      if (code === "0x") {
        console.log(`${name} (${address}) yok / deploy edilmemiş.`);
      } else {
        console.log(`${name} (${address}) var, işlem yapılabilir.`);
      }
    } catch (err) {
      console.log(`${name} (${address}) kontrol edilirken hata:`, err.message);
    }
  }
}

checkContracts();
